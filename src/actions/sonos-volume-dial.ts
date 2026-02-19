import { action, DialAction, DialRotateEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DialUpEvent, TouchTapEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { Sonos } from 'sonos';

/**
 * Per-instance state for each dial action, keyed by action ID.
 */
type InstanceState = {
	sonos: Sonos | null;
	lastKnownVolume: number;
	isMuted: boolean;
	pollInterval: { active: boolean } | null;
	pollTimeoutId: NodeJS.Timeout | null;
	currentAction: DialAction<SonosVolumeDialSettings> | null;
	currentSettings: SonosVolumeDialSettings | null;
	volumeChangeTimeout: NodeJS.Timeout | null;
	isRotating: boolean;
};

/**
 * Sonos Volume Dial action that controls a Sonos speaker's volume.
 */
@action({ UUID: 'com.0xjessel.sonos-volume-dial.volume' })
export class SonosVolumeDial extends SingletonAction {
	// Constants
	private static readonly POLLING_INTERVAL_MS = 3000;
	private static readonly VOLUME_CHANGE_DEBOUNCE_MS = 500;

	private logger = streamDeck.logger.createScope('SonosVolumeDial');
	private instances = new Map<string, InstanceState>();

	private getState(id: string): InstanceState {
		let state = this.instances.get(id);
		if (!state) {
			state = {
				sonos: null,
				lastKnownVolume: 50,
				isMuted: false,
				pollInterval: null,
				pollTimeoutId: null,
				currentAction: null,
				currentSettings: null,
				volumeChangeTimeout: null,
				isRotating: false,
			};
			this.instances.set(id, state);
		}
		return state;
	}

	/**
	 * Start polling for speaker state
	 */
	private startPolling(dialAction: DialAction<SonosVolumeDialSettings>) {
		const actionId = dialAction.id;
		const state = this.getState(actionId);
		// Create a scoped logger for polling
		const logger = this.logger.createScope(`Polling[${actionId}]`);

		// Only start polling if there isn't already an active poll
		if (state.pollInterval?.active) {
			logger.debug('Polling already active, skipping');
			return;
		}

		// Clear any existing poll interval just in case, but preserve state
		if (state.pollInterval) {
			state.pollInterval.active = false;
			state.pollInterval = null;
		}

		// Clear any existing timeout
		if (state.pollTimeoutId) {
			clearTimeout(state.pollTimeoutId);
			state.pollTimeoutId = null;
		}

		// Store the current action for use in the polling function
		state.currentAction = dialAction;

		// Verify we have necessary state to start polling
		if (!state.currentAction || !state.currentSettings) {
			logger.debug('Missing required state, cannot start polling');
			return;
		}

		// Start polling using self-scheduling
		state.pollInterval = { active: true };
		logger.debug('Starting polling');
		this.pollWithDelay(actionId, logger);
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
	private async pollWithDelay(actionId: string, logger: ReturnType<typeof streamDeck.logger.createScope>) {
		const state = this.getState(actionId);

		// Ensure we're not running multiple polling cycles
		if (!state.pollInterval?.active) {
			return;
		}

		try {
			if (!state.currentAction || !state.currentSettings) {
				logger.debug('No current action or settings, stopping polling');
				this.stopPolling(actionId);
				return;
			}

			try {
				// If we don't have a connection, try to reconnect
				if (!state.sonos) {
					if (state.currentSettings.speakerIp) {
						logger.info('Reconnecting to speaker:', state.currentSettings.speakerIp);
						state.sonos = new Sonos(state.currentSettings.speakerIp);
					} else {
						logger.debug('No speaker IP, stopping polling');
						this.stopPolling(actionId);
						return;
					}
				}

				// Get current volume and mute state
				const [volume, isMuted] = await Promise.all([
					state.sonos.getVolume(),
					state.sonos.getMuted()
				]);

				// Only update if values have changed and we're not actively rotating
				if ((volume !== state.lastKnownVolume || isMuted !== state.isMuted) && !state.isRotating) {
					logger.debug('Speaker state changed externally - volume:', volume, 'muted:', isMuted);
					state.lastKnownVolume = volume;
					state.isMuted = isMuted;

					// Update UI to reflect current state
					state.currentAction.setFeedback({
						value: {
							value: volume,
							opacity: isMuted ? 0.5 : 1.0,
						},
						indicator: {
							value: volume,
							opacity: isMuted ? 0.5 : 1.0
						}
					});
					state.currentAction.setSettings({ ...state.currentSettings, value: volume });
				}
			} catch (error) {
				logger.error('Failed to poll speaker state:', {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined
				});
				// Don't stop polling on error, just clear the connection so we'll try to reconnect next time
				state.sonos = null;
			}
		} finally {
			// Schedule next poll only if polling is still active
			if (state.pollInterval?.active) {
				if (state.pollTimeoutId) {
					clearTimeout(state.pollTimeoutId);
				}
				state.pollTimeoutId = setTimeout(() => {
					state.pollTimeoutId = null;
					if (state.pollInterval?.active) {
						this.pollWithDelay(actionId, logger);
					}
				}, SonosVolumeDial.POLLING_INTERVAL_MS);
			}
		}
	}

	/**
	 * Stop polling for speaker state
	 */
	private stopPolling(actionId: string) {
		const state = this.instances.get(actionId);
		if (!state) return;

		if (state.pollInterval) {
			this.logger.debug(`Stopping polling for ${actionId}`);
			state.pollInterval.active = false;
			state.pollInterval = null;
		}
		if (state.pollTimeoutId) {
			clearTimeout(state.pollTimeoutId);
			state.pollTimeoutId = null;
		}
		state.currentAction = null;
		state.currentSettings = null;
	}

	/**
	 * Clean up when the action is removed
	 */
	override onWillDisappear(ev: WillDisappearEvent<SonosVolumeDialSettings>): void {
		const actionId = ev.action.id;
		const state = this.instances.get(actionId);
		if (!state) return;

		if (state.volumeChangeTimeout) {
			clearTimeout(state.volumeChangeTimeout);
			state.volumeChangeTimeout = null;
		}
		this.stopPolling(actionId);
		this.instances.delete(actionId);
	}

	/**
	 * Sets the initial value when the action appears on Stream Deck.
	 */
	override async onWillAppear(ev: WillAppearEvent<SonosVolumeDialSettings>): Promise<void> {
		const actionId = ev.action.id;
		const logger = this.logger.createScope(`WillAppear[${actionId}]`);
		
		try {
			// Verify that the action is a dial so we can call setFeedback.
			if (!ev.action.isDial()) return;

			const dialAction = ev.action as DialAction<SonosVolumeDialSettings>;
			const state = this.getState(actionId);
			const { speakerIp, value = 50, volumeStep = 5 } = ev.payload.settings;

			// Store current settings and action first
			state.currentAction = dialAction;
			state.currentSettings = ev.payload.settings;

			// Initialize display with current or default value
			dialAction.setFeedback({ 
				value: {
					value,
					opacity: state.isMuted ? 0.5 : 1.0
				},
				indicator: { 
					value,
					opacity: state.isMuted ? 0.5 : 1.0
				},
			});

			// If we have a speaker IP, initialize the connection and update volume
			if (speakerIp) {
				logger.info('Connecting to Sonos speaker:', speakerIp);
				state.sonos = new Sonos(speakerIp);
				
				try {
					// Get current volume and mute state
					const [volume, isMuted] = await Promise.all([
						state.sonos.getVolume(),
						state.sonos.getMuted()
					]);
					
					state.lastKnownVolume = volume;
					state.isMuted = isMuted;
					
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
					state.sonos = null;
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
		const actionId = ev.action.id;
		const logger = this.logger.createScope(`DialRotate[${actionId}]`);
		const dialAction = ev.action as DialAction<SonosVolumeDialSettings>;
		const state = this.getState(actionId);
		
		try {
			const { speakerIp, value = state.lastKnownVolume, volumeStep = 5 } = ev.payload.settings;

			// Mark that we're actively rotating
			state.isRotating = true;

			// Update stored settings
			state.currentSettings = ev.payload.settings;
			
			const { ticks } = ev.payload;

			// Calculate new value using the volumeStep setting
			const newValue = Math.max(0, Math.min(100, value + (ticks * volumeStep)));

			// Update UI immediately for responsiveness
			dialAction.setFeedback({ 
				value: {
					value: newValue,
					opacity: state.isMuted ? 0.5 : 1.0,
				},
				indicator: { 
					value: newValue,
					opacity: state.isMuted ? 0.5 : 1.0
				}
			});
			dialAction.setSettings({ ...state.currentSettings, value: newValue });
			state.lastKnownVolume = newValue;

			// Clear any pending volume change
			if (state.volumeChangeTimeout) {
				clearTimeout(state.volumeChangeTimeout);
				state.volumeChangeTimeout = null;
			}

			// Handle Sonos operations in the background after debounce
			if (speakerIp) {
				state.volumeChangeTimeout = setTimeout(async () => {
					try {
						// Initialize connection if needed
						if (!state.sonos) {
							logger.info('Reconnecting to speaker:', speakerIp);
							state.sonos = new Sonos(speakerIp);
						}

						// If speaker is muted, unmute it first
						if (state.isMuted) {
							await state.sonos.setMuted(false);
							state.isMuted = false;
						}

						// Set the volume without waiting for verification
						await state.sonos.setVolume(newValue);
						logger.debug('Volume successfully set to:', newValue);
					} catch (error) {
						logger.error('Failed to update volume:', {
							error: error instanceof Error ? error.message : String(error),
							stack: error instanceof Error ? error.stack : undefined,
							targetVolume: newValue
						});
						state.sonos = null;
						this.showAlert(dialAction, 'Failed to update volume');
					} finally {
						// Clear rotating flag and restart polling only after the last debounced update
						state.isRotating = false;
						this.startPolling(dialAction);
					}
				}, SonosVolumeDial.VOLUME_CHANGE_DEBOUNCE_MS);
			} else {
				logger.warn('No speaker IP configured');
				this.showAlert(dialAction, 'No speaker IP configured');
				state.isRotating = false;
			}
		} catch (error) {
			logger.error('Error in onDialRotate:', {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});
			state.isRotating = false;
		}
	}

	/**
	 * Toggle mute state when the dial is pressed.
	 */
	override async onDialUp(ev: DialUpEvent<SonosVolumeDialSettings>): Promise<void> {
		const actionId = ev.action.id;
		const logger = this.logger.createScope(`DialUp[${actionId}]`);
		
		try {
			const dialAction = ev.action as DialAction<SonosVolumeDialSettings>;
			const state = this.getState(actionId);
			const { speakerIp } = ev.payload.settings;

			// Update UI immediately with optimistic state
			const newMutedState = !state.isMuted;
			state.isMuted = newMutedState;
			dialAction.setFeedback({ 
				value: {
					value: state.lastKnownVolume,
					opacity: newMutedState ? 0.5 : 1.0,
				},
				indicator: { 
					value: state.lastKnownVolume,
					opacity: newMutedState ? 0.5 : 1.0
				}
			});

			// Handle Sonos operations in the background
			if (speakerIp) {
				Promise.resolve().then(async () => {
					try {
						// Initialize connection if needed
						if (!state.sonos) {
							logger.info('Reconnecting to speaker:', speakerIp);
							state.sonos = new Sonos(speakerIp);
							// Restart polling if it was stopped
							if (!state.pollInterval) {
								this.startPolling(dialAction);
							}
						}

						// Set mute state without waiting for verification
						await state.sonos.setMuted(newMutedState);
					} catch (error) {
						logger.error('Failed to toggle mute:', {
							error: error instanceof Error ? error.message : String(error),
							stack: error instanceof Error ? error.stack : undefined
						});
						state.sonos = null;
						this.showAlert(dialAction, 'Failed to toggle mute');
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
		const actionId = ev.action.id;
		const logger = this.logger.createScope(`TouchTap[${actionId}]`);
		
		try {
			const dialAction = ev.action as DialAction<SonosVolumeDialSettings>;
			const state = this.getState(actionId);
			const { speakerIp } = ev.payload.settings;

			// Update UI immediately with optimistic state
			const newMutedState = !state.isMuted;
			state.isMuted = newMutedState;
			dialAction.setFeedback({ 
				value: {
					value: state.lastKnownVolume,
					opacity: newMutedState ? 0.5 : 1.0,
				},
				indicator: { 
					value: state.lastKnownVolume,
					opacity: newMutedState ? 0.5 : 1.0
				}
			});

			// Handle Sonos operations in the background
			if (speakerIp) {
				Promise.resolve().then(async () => {
					try {
						// Initialize connection if needed
						if (!state.sonos) {
							logger.info('Reconnecting to speaker:', speakerIp);
							state.sonos = new Sonos(speakerIp);
							// Restart polling if it was stopped
							if (!state.pollInterval) {
								this.startPolling(dialAction);
							}
						}

						// Set mute state without waiting for verification
						await state.sonos.setMuted(newMutedState);
					} catch (error) {
						logger.error('Failed to toggle mute:', {
							error: error instanceof Error ? error.message : String(error),
							stack: error instanceof Error ? error.stack : undefined
						});
						state.sonos = null;
						this.showAlert(dialAction, 'Failed to toggle mute');
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
		const actionId = ev.action.id;
		const logger = this.logger.createScope(`DidReceiveSettings[${actionId}]`);
		
		try {
			if (!ev.action.isDial()) return;

			const dialAction = ev.action as DialAction<SonosVolumeDialSettings>;
			const state = this.getState(actionId);
			const { speakerIp, value = state.lastKnownVolume, volumeStep = 5 } = ev.payload.settings;

			const previousIp = state.currentSettings?.speakerIp;

			// Store current settings
			state.currentSettings = ev.payload.settings;

			// If speaker IP changed, we need to reconnect
			if (speakerIp !== previousIp) {
				// Clear existing connection
				state.sonos = null;
				this.stopPolling(actionId);

				if (speakerIp) {
					logger.info('Connecting to new speaker:', speakerIp);
					state.sonos = new Sonos(speakerIp);
					
					try {
						// Get current volume and mute state
						const [volume, isMuted] = await Promise.all([
							state.sonos.getVolume(),
							state.sonos.getMuted()
						]);
						
						state.lastKnownVolume = volume;
						state.isMuted = isMuted;
						
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
						state.sonos = null;
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