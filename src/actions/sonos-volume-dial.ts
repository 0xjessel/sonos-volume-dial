import { action, DialAction, DialRotateEvent, SingletonAction, WillAppearEvent, DialUpEvent, TouchTapEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { Sonos } from 'sonos';

/**
 * Sonos Volume Dial action that controls a Sonos speaker's volume.
 */
@action({ UUID: 'com.0xjessel.sonos-volume-dial.volume' })
export class SonosVolumeDial extends SingletonAction {
	// Constants
	private static readonly POLLING_INTERVAL_MS = 3000;
	private static readonly VOLUME_CHANGE_DEBOUNCE_MS = 500;

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
				const [volume, isMuted] = await Promise.all([
					this.sonos.getVolume(),
					this.sonos.getMuted()
				]);

				// Only update if values have changed and we're not actively rotating
				if ((volume !== this.lastKnownVolume || isMuted !== this.isMuted) && !this.isRotating) {
					logger.debug('Speaker state changed externally - volume:', volume, 'muted:', isMuted);
					this.lastKnownVolume = volume;
					this.isMuted = isMuted;

					// Update UI to reflect current state
					this.currentAction.setFeedback({
						value: {
							value: volume,
							opacity: isMuted ? 0.5 : 1.0,
						},
						indicator: {
							value: volume,
							opacity: isMuted ? 0.5 : 1.0
						}
					});
					this.currentAction.setSettings({ ...this.currentSettings, value: volume });
				}
			} catch (error) {
				logger.error('Failed to poll speaker state:', {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined
				});
				// Don't stop polling on error, just clear the connection so we'll try to reconnect next time
				this.sonos = null;
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

			// Initialize display with current or default value
			dialAction.setFeedback({ 
				value: {
					value,
					opacity: this.isMuted ? 0.5 : 1.0
				},
				indicator: { 
					value,
					opacity: this.isMuted ? 0.5 : 1.0
				},
			});

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
					dialAction.setFeedback({ 
						value: {
							value: volume,
							opacity: isMuted ? 0.5 : 1.0,
						},
						indicator: { 
							value: volume,
							opacity: isMuted ? 0.5 : 1.0
						}
					});

					// Send settings back to Property Inspector with current volume
					dialAction.setSettings({ speakerIp, volumeStep, value: volume });

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
					dialAction.setSettings({ speakerIp, volumeStep, value });
				}
			} else {
				logger.warn('No speaker IP configured');
				// Ensure settings are synced even when no IP is configured
				dialAction.setSettings({ volumeStep, value });
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

			// Update UI immediately for responsiveness
			dialAction.setFeedback({ 
				value: {
					value: newValue,
					opacity: this.isMuted ? 0.5 : 1.0,
				},
				indicator: { 
					value: newValue,
					opacity: this.isMuted ? 0.5 : 1.0
				}
			});
			dialAction.setSettings({ ...this.currentSettings, value: newValue });
			this.lastKnownVolume = newValue;

			// Clear any pending volume change
			if (this.volumeChangeTimeout) {
				clearTimeout(this.volumeChangeTimeout);
				this.volumeChangeTimeout = null;
			}

			// Handle Sonos operations in the background after debounce
			if (speakerIp) {
				this.volumeChangeTimeout = setTimeout(async () => {
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
						await this.sonos.setVolume(newValue);
					} catch (error) {
						logger.error('Failed to update volume:', {
							error: error instanceof Error ? error.message : String(error),
							stack: error instanceof Error ? error.stack : undefined,
							targetVolume: newValue
						});
						this.sonos = null;
						this.showAlert(dialAction, 'Failed to update volume');
					} finally {
						// Clear rotating flag and restart polling only after the last debounced update
						this.isRotating = false;
						this.startPolling(dialAction);
					}
				}, SonosVolumeDial.VOLUME_CHANGE_DEBOUNCE_MS);
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
			dialAction.setFeedback({ 
				value: {
					value: this.lastKnownVolume,
					opacity: newMutedState ? 0.5 : 1.0,
				},
				indicator: { 
					value: this.lastKnownVolume,
					opacity: newMutedState ? 0.5 : 1.0
				}
			});

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
			dialAction.setFeedback({ 
				value: {
					value: this.lastKnownVolume,
					opacity: newMutedState ? 0.5 : 1.0,
				},
				indicator: { 
					value: this.lastKnownVolume,
					opacity: newMutedState ? 0.5 : 1.0
				}
			});

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

			// Store current settings
			this.currentSettings = ev.payload.settings;

			// If speaker IP changed, we need to reconnect
			if (speakerIp !== this.currentSettings?.speakerIp) {
				// Clear existing connection
				this.sonos = null;
				this.stopPolling();

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
						dialAction.setFeedback({ 
							value: {
								value: volume,
								opacity: isMuted ? 0.5 : 1.0,
							},
							indicator: { 
								value: volume,
								opacity: isMuted ? 0.5 : 1.0
							}
						});
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
	volumeStep: number;
};