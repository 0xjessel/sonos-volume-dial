import { action, DialAction, DialRotateEvent, SingletonAction, WillAppearEvent, DialUpEvent, TouchTapEvent, DidReceiveSettingsEvent, SendToPluginEvent, TitleParametersDidChangeEvent, JsonValue } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { Sonos, AsyncDeviceDiscovery } from 'sonos';

/**
 * Sonos Volume Dial action that controls a Sonos speaker's volume.
 */
@action({ UUID: 'com.0xjessel.sonos-volume-dial.volume' })
export class SonosVolumeDial extends SingletonAction {
	// Constants
	private static readonly POLLING_INTERVAL_MS = 3000;
	private static readonly VOLUME_WRITE_INTERVAL_MS = 120;
	private static readonly DISCOVERY_TIMEOUT_MS = 4000;
	private static readonly RERESOLVE_MIN_INTERVAL_MS = 30000;

	private sonos: Sonos | null = null;
	private lastKnownVolume: number = 50;
	private isMuted: boolean = false;
	private logger = streamDeck.logger.createScope('SonosVolumeDial');
	private pollInterval: { active: boolean } | null = null;
	private pollTimeoutId: NodeJS.Timeout | null = null;
	private currentAction: DialAction<SonosVolumeDialSettings> | null = null;
	private currentSettings: SonosVolumeDialSettings | null = null;
	private volumeChangeTimeout: NodeJS.Timeout | null = null;
	private isRotating: boolean = false;
	private lastWriteCompletedAt: number = 0;
	private pendingVolume: number = 0;
	private writeInFlight: boolean = false;
	private lastReResolveAt: number = 0;
	private userTitle: string | null = null;

	/**
	 * Start polling for speaker state
	 */
	private startPolling(dialAction: DialAction<SonosVolumeDialSettings>) {
		// Create a scoped logger for polling
		const logger = this.logger.createScope('Polling');

		// Only start polling if there isn't already an active poll
		if (this.pollInterval?.active) {
			logger.debug('Polling already active, skipping');
			return;
		}

		// Clear any existing poll interval just in case, but preserve state
		if (this.pollInterval) {
			this.pollInterval.active = false;
			this.pollInterval = null;
		}

		// Clear any existing timeout
		if (this.pollTimeoutId) {
			clearTimeout(this.pollTimeoutId);
			this.pollTimeoutId = null;
		}

		// Store the current action for use in the polling function
		this.currentAction = dialAction;

		// Verify we have necessary state to start polling
		if (!this.currentAction || !this.currentSettings) {
			logger.debug('Missing required state, cannot start polling');
			return;
		}

		// Start polling using self-scheduling
		this.pollInterval = { active: true };
		logger.debug('Starting polling');
		this.pollWithDelay(logger);
	}

	/**
	 * Show an alert to the user
	 */
	private showAlert(action: DialAction<SonosVolumeDialSettings>, message: string) {
		action.showAlert();
		this.logger.error(message);
	}

	/**
	 * Self-scheduling poll function that maintains consistent spacing
	 */
	private async pollWithDelay(logger: ReturnType<typeof streamDeck.logger.createScope>) {
		// Ensure we're not running multiple polling cycles
		if (!this.pollInterval?.active) {
			return;
		}

		try {
			if (!this.currentAction || !this.currentSettings) {
				logger.debug('No current action or settings, stopping polling');
				this.stopPolling();
				return;
			}

			try {
				// If we don't have a connection, try to reconnect
				if (!this.sonos) {
					if (this.currentSettings.speakerIp) {
						logger.info('Reconnecting to speaker:', this.currentSettings.speakerIp);
						this.sonos = new Sonos(this.currentSettings.speakerIp);
					} else {
						logger.debug('No speaker IP, stopping polling');
						this.stopPolling();
						return;
					}
				}

				// Get current volume and mute state
				const pollStartedAt = Date.now();
				const [volume, isMuted] = await Promise.all([
					this.sonos.getVolume(),
					this.sonos.getMuted()
				]);

				// Discard this reading if a write to the speaker completed after the poll started:
				// it is stale and would overwrite the value just written.
				if (this.lastWriteCompletedAt > pollStartedAt) {
					logger.debug('Discarding poll reading that raced a write');
				} else if ((volume !== this.lastKnownVolume || isMuted !== this.isMuted) && !this.isRotating) {
					logger.debug('Speaker state changed externally - volume:', volume, 'muted:', isMuted);
					this.lastKnownVolume = volume;
					this.isMuted = isMuted;

					// Update UI to reflect current state
					this.currentAction.setFeedback(this.feedbackFor(volume, isMuted));
					this.currentAction.setSettings({ ...this.currentSettings, value: volume });
				}
			} catch (error) {
				logger.error('Failed to poll speaker state:', {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined
				});
				// Don't stop polling on error, just clear the connection so we'll try to reconnect next time
				this.sonos = null;
				// If the speaker was chosen by room name, its address may have changed: re-resolve it.
				if (this.currentAction && this.currentSettings?.roomName) {
					void this.resolveRoom(this.currentAction, this.currentSettings, false);
				}
			}
		} finally {
			// Schedule next poll only if polling is still active
			if (this.pollInterval?.active) {
				if (this.pollTimeoutId) {
					clearTimeout(this.pollTimeoutId);
				}
				this.pollTimeoutId = setTimeout(() => {
					this.pollTimeoutId = null;
					if (this.pollInterval?.active) {
						this.pollWithDelay(logger);
					}
				}, SonosVolumeDial.POLLING_INTERVAL_MS);
			}
		}
	}

	/**
	 * Stop polling for speaker state
	 */
	private stopPolling() {
		if (this.pollInterval) {
			this.logger.debug('Stopping polling');
			this.pollInterval.active = false;
			this.pollInterval = null;
		}
		if (this.pollTimeoutId) {
			clearTimeout(this.pollTimeoutId);
			this.pollTimeoutId = null;
		}
		this.currentAction = null;
		this.currentSettings = null;
	}

	/**
	 * Clean up when the action is removed
	 */
	override onWillDisappear(): void {
		if (this.volumeChangeTimeout) {
			clearTimeout(this.volumeChangeTimeout);
			this.volumeChangeTimeout = null;
		}
		this.stopPolling();
	}

	/**
	 * Sets the initial value when the action appears on Stream Deck.
	 */
	override async onWillAppear(ev: WillAppearEvent<SonosVolumeDialSettings>): Promise<void> {
		// Create a scoped logger for this specific instance
		const logger = this.logger.createScope('WillAppear');
		
		try {
			// Verify that the action is a dial so we can call setFeedback.
			if (!ev.action.isDial()) return;

			const dialAction = ev.action as DialAction<SonosVolumeDialSettings>;
			const { speakerIp, value = 50, volumeStep = 5 } = ev.payload.settings;

			// Store current settings and action first
			this.currentAction = dialAction;
			this.currentSettings = ev.payload.settings;
			this.applyTitle(dialAction, ev.payload.settings);

			// Initialize display with current or default value
			dialAction.setFeedback(this.feedbackFor(value, this.isMuted));

			// If we have a speaker IP, initialize the connection and update volume
			if (speakerIp) {
				logger.info('Connecting to Sonos speaker:', speakerIp);
				this.sonos = new Sonos(speakerIp);
				
				try {
					// Get current volume and mute state
					const [volume, isMuted] = await Promise.all([
						this.sonos.getVolume(),
						this.sonos.getMuted()
					]);
					
					this.lastKnownVolume = volume;
					this.isMuted = isMuted;
					
					// Update UI with current state
					dialAction.setFeedback(this.feedbackFor(volume, isMuted));

					// Send settings back to Property Inspector with current volume, keeping
					// everything else (room name included) intact
					dialAction.setSettings({ ...ev.payload.settings, speakerIp, volumeStep, value: volume });

					// Start polling for updates only after we've successfully connected and initialized
					this.startPolling(dialAction);
				} catch (error) {
					logger.error('Failed to connect to speaker:', {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined
					});
					this.sonos = null;
					this.showAlert(dialAction, 'Failed to connect to speaker');
					// Even if connection fails, ensure settings are synced
					dialAction.setSettings({ ...ev.payload.settings, speakerIp, volumeStep, value });
				}
			} else {
				logger.warn('No speaker IP configured');
				// Ensure settings are synced even when no IP is configured
				dialAction.setSettings({ ...ev.payload.settings, volumeStep, value });
			}

			// If the speaker was chosen by room name, confirm its address in the background
			// so a DHCP change heals itself without the user touching the settings.
			if (ev.payload.settings.roomName) {
				void this.resolveRoom(dialAction, ev.payload.settings, true);
			}
		} catch (error) {
			logger.error('Error in onWillAppear:', {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});
		}
	}

	/**
	 * Update the value based on the dial rotation.
	 */
	override async onDialRotate(ev: DialRotateEvent<SonosVolumeDialSettings>): Promise<void> {
		// Create a scoped logger for this specific rotation event
		const logger = this.logger.createScope('DialRotate');
		const dialAction = ev.action as DialAction<SonosVolumeDialSettings>;
		
		try {
			const { speakerIp, value = this.lastKnownVolume, volumeStep = 5 } = ev.payload.settings;

			// Mark that we're actively rotating
			this.isRotating = true;

			// Update stored settings
			this.currentSettings = ev.payload.settings;
			
			const { ticks } = ev.payload;

			// Calculate new value using the volumeStep setting
			const newValue = Math.max(0, Math.min(100, value + (ticks * volumeStep)));
			logger.debug('Tick:', ticks, 'from', value, 'to', newValue);

			// Update UI immediately for responsiveness
			dialAction.setFeedback(this.feedbackFor(newValue, this.isMuted));
			dialAction.setSettings({ ...this.currentSettings, value: newValue });
			this.lastKnownVolume = newValue;

			// Remember the latest requested value. Writes to the speaker are throttled:
			// while the dial is turning, the newest value is written at most once per
			// VOLUME_WRITE_INTERVAL_MS, only one write is ever in flight, and the final
			// value is always written once the dial stops. This lets the volume be heard
			// changing during a long turn instead of only after it ends.
			this.pendingVolume = newValue;

			if (speakerIp) {
				this.scheduleVolumeWrite(dialAction, speakerIp);
			} else {
				logger.warn('No speaker IP configured');
				this.showAlert(dialAction, 'No speaker IP configured');
				this.isRotating = false;
			}
		} catch (error) {
			logger.error('Error in onDialRotate:', {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});
			this.isRotating = false;
		}
	}

	private static readonly ICON_LIVE = 'imgs/actions/speaker.wave.3.png';
	private static readonly ICON_MUTED = 'imgs/actions/speaker.muted.svg';

	/**
	 * Touch-strip feedback for a given state: the icon swaps to a red-struck
	 * speaker when muted, and the level readout and bar dim.
	 */
	private feedbackFor(volume: number, muted: boolean) {
		return {
			icon: muted ? SonosVolumeDial.ICON_MUTED : SonosVolumeDial.ICON_LIVE,
			value: { value: volume, opacity: muted ? 0.5 : 1.0 },
			indicator: { value: volume, opacity: muted ? 0.5 : 1.0 }
		};
	}

	/**
	 * Show which speaker this dial controls on the touch strip. A title typed
	 * into the Stream Deck app's Title field overrides it; otherwise the room
	 * name when chosen via discovery, otherwise the IP, otherwise a placeholder.
	 */
	private applyTitle(dialAction: DialAction<SonosVolumeDialSettings>, settings: SonosVolumeDialSettings): void {
		dialAction.setFeedback({ title: this.userTitle ?? settings.roomName ?? settings.speakerIp ?? 'Sonos' });
	}

	/**
	 * The user edited the Title field in the Stream Deck app. Blank means
	 * "use the room name".
	 */
	override onTitleParametersDidChange(ev: TitleParametersDidChangeEvent<SonosVolumeDialSettings>): void {
		if (!ev.action.isDial()) return;
		const title = ev.payload.title.trim();
		this.userTitle = title.length > 0 ? title : null;
		this.applyTitle(ev.action as DialAction<SonosVolumeDialSettings>, ev.payload.settings);
	}

	/**
	 * Find Sonos rooms on the local network via SSDP. Returns one entry per
	 * group, named after the group's coordinator, with the coordinator's IP.
	 * Bonded surrounds and subs are not listed separately, which is what we
	 * want: volume is set on the coordinator.
	 */
	private async discoverRooms(): Promise<DiscoveredRoom[]> {
		const discovery = new AsyncDeviceDiscovery();
		const device = await discovery.discover({ timeout: SonosVolumeDial.DISCOVERY_TIMEOUT_MS });
		const groups = await device.getAllGroups();
		const rooms = new Map<string, DiscoveredRoom>();
		for (const group of groups) {
			if (!group.host) continue;
			const coordinator = group.ZoneGroupMember.find((member) => member.UUID === group.Coordinator);
			const name = coordinator?.ZoneName ?? group.Name;
			if (!rooms.has(name)) {
				rooms.set(name, { name, host: group.host });
			}
		}
		return [...rooms.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Re-resolve a room name to its current IP and reconnect if it moved.
	 * `force` bypasses the rate limit (used on appear); otherwise attempts are
	 * spaced at least RERESOLVE_MIN_INTERVAL_MS apart so a dead network does
	 * not trigger a discovery on every failed poll.
	 */
	private async resolveRoom(dialAction: DialAction<SonosVolumeDialSettings>, settings: SonosVolumeDialSettings, force: boolean): Promise<void> {
		const logger = this.logger.createScope('ResolveRoom');
		const { roomName } = settings;
		if (!roomName) return;
		const now = Date.now();
		if (!force && now - this.lastReResolveAt < SonosVolumeDial.RERESOLVE_MIN_INTERVAL_MS) return;
		this.lastReResolveAt = now;

		try {
			const rooms = await this.discoverRooms();

			// The user may have picked a different room, or an IP, while discovery ran.
			// Only act on the result if the request still describes the current setup.
			if (this.currentSettings?.roomName !== roomName || this.currentSettings?.speakerIp !== settings.speakerIp) {
				logger.debug('Discarding stale room resolution for', roomName);
				return;
			}

			const room = rooms.find((r) => r.name === roomName);
			if (!room) {
				logger.warn('Room not found on the network:', roomName);
				return;
			}
			if (room.host === settings.speakerIp) {
				logger.debug('Room address unchanged:', roomName, room.host);
				return;
			}
			logger.info('Room address changed:', roomName, settings.speakerIp, '->', room.host);
			const updated = { ...this.currentSettings, speakerIp: room.host };
			this.currentSettings = updated;
			this.sonos = new Sonos(room.host);
			dialAction.setSettings(updated);
			this.startPolling(dialAction);
		} catch (error) {
			logger.warn('Discovery failed while re-resolving room:', {
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	/**
	 * Messages from the property inspector. Currently only room discovery.
	 */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SonosVolumeDialSettings>): Promise<void> {
		const logger = this.logger.createScope('SendToPlugin');
		const payload = ev.payload as { event?: string } | null;
		if (payload?.event !== 'discoverRooms') return;

		try {
			const rooms = await this.discoverRooms();
			logger.info('Discovered rooms:', rooms.map((r) => `${r.name}=${r.host}`).join(', '));
			await streamDeck.ui.current?.sendToPropertyInspector({ event: 'rooms', rooms });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn('Discovery failed:', message);
			await streamDeck.ui.current?.sendToPropertyInspector({ event: 'discoveryFailed', message });
		}
	}

	/**
	 * Schedule a write of the latest pending volume, unless one is already
	 * scheduled or in flight. The in-flight write drains any newer value when
	 * it settles, so writes never overlap and the last value always wins.
	 */
	private scheduleVolumeWrite(dialAction: DialAction<SonosVolumeDialSettings>, speakerIp: string): void {
		if (this.volumeChangeTimeout || this.writeInFlight) {
			return;
		}
		this.volumeChangeTimeout = setTimeout(() => {
			this.volumeChangeTimeout = null;
			void this.writePendingVolume(dialAction, speakerIp);
		}, SonosVolumeDial.VOLUME_WRITE_INTERVAL_MS);
	}

	/**
	 * Write the latest pending volume to the speaker. Exactly one write runs at
	 * a time; if the dial moved while this write was in flight, the newer value
	 * is scheduled once this one settles.
	 */
	private async writePendingVolume(dialAction: DialAction<SonosVolumeDialSettings>, speakerIp: string): Promise<void> {
		const logger = this.logger.createScope('VolumeWrite');
		const targetVolume = this.pendingVolume;
		this.writeInFlight = true;
		try {
			// Initialize connection if needed
			if (!this.sonos) {
				logger.info('Reconnecting to speaker:', speakerIp);
				this.sonos = new Sonos(speakerIp);
			}

			// If speaker is muted, unmute it first
			if (this.isMuted) {
				await this.sonos.setMuted(false);
				this.isMuted = false;
			}

			// Set the volume without waiting for verification
			await this.sonos.setVolume(targetVolume);
			this.lastWriteCompletedAt = Date.now();
			logger.debug('Volume successfully set to:', targetVolume);
		} catch (error) {
			logger.error('Failed to update volume:', {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				targetVolume
			});
			this.sonos = null;
			this.showAlert(dialAction, 'Failed to update volume');
		} finally {
			this.writeInFlight = false;
			if (this.pendingVolume !== targetVolume) {
				// The dial moved during the write: drain the newer value.
				this.scheduleVolumeWrite(dialAction, speakerIp);
			} else {
				// The turn is over.
				this.isRotating = false;
				this.startPolling(dialAction);
			}
		}
	}

	/**
	 * Toggle mute state when the dial is pressed.
	 */
	override async onDialUp(ev: DialUpEvent<SonosVolumeDialSettings>): Promise<void> {
		// Create a scoped logger for this specific press event
		const logger = this.logger.createScope('DialUp');
		
		try {
			const dialAction = ev.action as DialAction<SonosVolumeDialSettings>;
			const { speakerIp } = ev.payload.settings;

			// Update UI immediately with optimistic state
			const newMutedState = !this.isMuted;
			this.isMuted = newMutedState;
			dialAction.setFeedback(this.feedbackFor(this.lastKnownVolume, newMutedState));

			// Handle Sonos operations in the background
			if (speakerIp) {
				Promise.resolve().then(async () => {
					try {
						// Initialize connection if needed
						if (!this.sonos) {
							logger.info('Reconnecting to speaker:', speakerIp);
							this.sonos = new Sonos(speakerIp);
							// Restart polling if it was stopped
							if (!this.pollInterval) {
								this.startPolling(dialAction);
							}
						}

						// Set mute state without waiting for verification
						// Let the polling cycle handle any discrepancies
						await this.sonos.setMuted(newMutedState);
						this.lastWriteCompletedAt = Date.now();
					} catch (error) {
						logger.error('Failed to toggle mute:', {
							error: error instanceof Error ? error.message : String(error),
							stack: error instanceof Error ? error.stack : undefined
						});
						this.sonos = null;
						this.showAlert(dialAction, 'Failed to toggle mute');
						// Keep optimistic update UI state, let polling sync actual state
					}
				});
			} else {
				logger.warn('No speaker IP configured');
				this.showAlert(dialAction, 'No speaker IP configured');
			}
		} catch (error) {
			logger.error('Error in onDialUp:', {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});
		}
	}

	/**
	 * Toggle mute state when the dial face is tapped.
	 */
	override async onTouchTap(ev: TouchTapEvent<SonosVolumeDialSettings>): Promise<void> {
		// Create a scoped logger for this specific tap event
		const logger = this.logger.createScope('TouchTap');
		
		try {
			const dialAction = ev.action as DialAction<SonosVolumeDialSettings>;
			const { speakerIp } = ev.payload.settings;

			// Update UI immediately with optimistic state
			const newMutedState = !this.isMuted;
			this.isMuted = newMutedState;
			dialAction.setFeedback(this.feedbackFor(this.lastKnownVolume, newMutedState));

			// Handle Sonos operations in the background
			if (speakerIp) {
				Promise.resolve().then(async () => {
					try {
						// Initialize connection if needed
						if (!this.sonos) {
							logger.info('Reconnecting to speaker:', speakerIp);
							this.sonos = new Sonos(speakerIp);
							// Restart polling if it was stopped
							if (!this.pollInterval) {
								this.startPolling(dialAction);
							}
						}

						// Set mute state without waiting for verification
						// Let the polling cycle handle any discrepancies
						await this.sonos.setMuted(newMutedState);
						this.lastWriteCompletedAt = Date.now();
					} catch (error) {
						logger.error('Failed to toggle mute:', {
							error: error instanceof Error ? error.message : String(error),
							stack: error instanceof Error ? error.stack : undefined
						});
						this.sonos = null;
						this.showAlert(dialAction, 'Failed to toggle mute');
						// Keep optimistic update UI state, let polling sync actual state
					}
				});
			} else {
				logger.warn('No speaker IP configured');
				this.showAlert(dialAction, 'No speaker IP configured');
			}
		} catch (error) {
			logger.error('Error in onTouchTap:', {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});
		}
	}

	/**
	 * Handle settings updates
	 */
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosVolumeDialSettings>): Promise<void> {
		const logger = this.logger.createScope('DidReceiveSettings');
		
		try {
			if (!ev.action.isDial()) return;

			const dialAction = ev.action as DialAction<SonosVolumeDialSettings>;
			const { speakerIp, value = this.lastKnownVolume, volumeStep = 5 } = ev.payload.settings;

			// Store current settings, keeping the previous ones for comparison
			const previousSettings = this.currentSettings;
			this.currentSettings = ev.payload.settings;
			this.applyTitle(dialAction, ev.payload.settings);

			// If speaker IP changed, we need to reconnect
			if (speakerIp !== previousSettings?.speakerIp) {
				// Clear existing connection. stopPolling() also clears the stored
				// action and settings, so put the new ones back before reconnecting.
				this.sonos = null;
				this.stopPolling();
				this.currentAction = dialAction;
				this.currentSettings = ev.payload.settings;

				if (speakerIp) {
					logger.info('Connecting to new speaker:', speakerIp);
					this.sonos = new Sonos(speakerIp);
					
					try {
						// Get current volume and mute state
						const [volume, isMuted] = await Promise.all([
							this.sonos.getVolume(),
							this.sonos.getMuted()
						]);
						
						this.lastKnownVolume = volume;
						this.isMuted = isMuted;
						
						// Update UI with current state
						dialAction.setFeedback(this.feedbackFor(volume, isMuted));
						dialAction.setSettings({ ...ev.payload.settings, value: volume });

						// Start polling for updates
						this.startPolling(dialAction);
					} catch (error) {
						logger.error('Failed to connect to new speaker:', {
							error: error instanceof Error ? error.message : String(error),
							stack: error instanceof Error ? error.stack : undefined
						});
						this.sonos = null;
						this.showAlert(dialAction, 'Failed to connect to speaker');
					}
				}
			}
		} catch (error) {
			logger.error('Error in onDidReceiveSettings:', {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});
		}
	}
}

/**
 * Settings for {@link SonosVolumeDial}.
 */
type SonosVolumeDialSettings = {
	value: number;
	speakerIp?: string;
	/** Room name chosen via discovery; used to re-resolve the IP if it changes. Absent for a manually entered IP. */
	roomName?: string;
	volumeStep: number;
};

type DiscoveredRoom = {
	name: string;
	host: string;
};