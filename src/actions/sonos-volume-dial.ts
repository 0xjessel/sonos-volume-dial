import { action, DialAction, DialRotateEvent, SingletonAction, WillAppearEvent, DialUpEvent, TouchTapEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { Sonos } from 'sonos';

/**
 * Sonos Volume Dial action that controls a Sonos speaker's volume.
 */
@action({ UUID: 'com.0xjessel.sonos-volume-dial.volume' })
export class SonosVolumeDial extends SingletonAction {
	private sonos: Sonos | null = null;
	private lastKnownVolume: number = 50;
	private isMuted: boolean = false;
	private logger = streamDeck.logger.createScope('SonosVolumeDial');
	private pollInterval: { active: boolean } | null = null;
	private currentAction: DialAction<SonosVolumeDialSettings> | null = null;
	private currentSettings: SonosVolumeDialSettings | null = null;

	/**
	 * Start polling for speaker state
	 */
	private startPolling(dialAction: DialAction<SonosVolumeDialSettings>) {
		// Clear any existing poll interval
		if (this.pollInterval) {
			this.pollInterval.active = false;
			this.pollInterval = null;
		}

		// Store the current action for use in the polling function
		this.currentAction = dialAction;

		// Create a scoped logger for polling
		const logger = this.logger.createScope('Polling');

		// Start polling every 5 seconds using self-scheduling
		this.pollInterval = { active: true };
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
	 * Self-scheduling poll function that maintains consistent 5-second spacing
	 */
	private async pollWithDelay(logger: ReturnType<typeof streamDeck.logger.createScope>) {
		if (!this.pollInterval?.active) return;

		try {
			if (!this.currentAction || !this.currentSettings) return;

			try {
				// If we don't have a connection, try to reconnect
				if (!this.sonos) {
					if (this.currentSettings.speakerIp) {
						logger.info('Reconnecting to speaker:', this.currentSettings.speakerIp);
						this.sonos = new Sonos(this.currentSettings.speakerIp);
					} else {
						return;
					}
				}

				// Get current volume and mute state
				const [volume, isMuted] = await Promise.all([
					this.sonos.getVolume(),
					this.sonos.getMuted()
				]);

				// Only update if values have changed
				if (volume !== this.lastKnownVolume || isMuted !== this.isMuted) {
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
				setTimeout(() => this.pollWithDelay(logger), 5000);
			}
		}
	}

	/**
	 * Stop polling for speaker state
	 */
	private stopPolling() {
		if (this.pollInterval) {
			this.pollInterval.active = false;
			this.pollInterval = null;
		}
		this.currentAction = null;
		this.currentSettings = null;
	}

	/**
	 * Clean up when the action is removed
	 */
	override onWillDisappear(): void {
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

			// Store current settings
			this.currentSettings = ev.payload.settings;

			logger.debug('Initializing with settings:', { speakerIp, value, volumeStep });

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

					// Start polling for updates
					this.startPolling(dialAction);

					// Send settings back to Property Inspector with current volume
					dialAction.setSettings({ speakerIp, volumeStep, value: volume });
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
		
		try {
			const dialAction = ev.action as DialAction<SonosVolumeDialSettings>;
			const { speakerIp, value = this.lastKnownVolume, volumeStep = 5 } = ev.payload.settings;

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

			// If we have a speaker IP, update the speaker volume in the background
			if (speakerIp) {
				// Initialize connection if needed
				if (!this.sonos) {
					logger.info('Reconnecting to speaker:', speakerIp);
					this.sonos = new Sonos(speakerIp);
					// Restart polling if it was stopped
					if (!this.pollInterval) {
						this.startPolling(dialAction);
					}
				}

				try {
					// If speaker is muted, unmute it first and verify
					if (this.isMuted) {
						await this.sonos.setMuted(false);
						
						// Verify unmute was successful
						const isMuted = await this.sonos.getMuted();
						if (isMuted) {
							logger.error('Failed to unmute speaker');
							this.showAlert(dialAction, 'Failed to unmute speaker');
							this.isMuted = true;
							// Update UI to reflect muted state
							dialAction.setFeedback({ 
								value: {
									value: newValue,
									opacity: 0.5,
								},
								indicator: { 
									value: newValue,
									opacity: 0.5
								}
							});
							return;
						}
						
						this.isMuted = false;
					}

					await this.sonos.setVolume(newValue);

					// Verify the volume was set correctly
					const actualVolume = await this.sonos.getVolume();
					if (actualVolume !== newValue) {
						logger.warn('Volume mismatch:', {
							expected: newValue,
							actual: actualVolume
						});
						this.showAlert(dialAction, 'Failed to set volume');
						// Update UI to reflect actual volume since it differs from our optimistic update
						dialAction.setFeedback({ 
							value: {
								value: actualVolume,
								opacity: this.isMuted ? 0.5 : 1.0,
							},
							indicator: { 
								value: actualVolume,
								opacity: this.isMuted ? 0.5 : 1.0
							}
						});
						dialAction.setSettings({ ...this.currentSettings, value: actualVolume });
						this.lastKnownVolume = actualVolume;
					}
				} catch (error) {
					logger.error('Failed to update volume:', {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined
					});
					this.sonos = null;
					this.showAlert(dialAction, 'Failed to update volume');
					// Keep optimistic update UI state, let polling sync actual state
				}
			} else {
				logger.warn('No speaker IP configured');
				this.showAlert(dialAction, 'No speaker IP configured');
			}
		} catch (error) {
			logger.error('Error in onDialRotate:', {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});
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

			// If we have a speaker IP, toggle mute state
			if (speakerIp) {
				// Initialize connection if needed
				if (!this.sonos) {
					logger.info('Reconnecting to speaker:', speakerIp);
					this.sonos = new Sonos(speakerIp);
					// Restart polling if it was stopped
					if (!this.pollInterval) {
						this.startPolling(dialAction);
					}
				}

				try {
					// Toggle mute state
					this.isMuted = !this.isMuted;
					await this.sonos.setMuted(this.isMuted);

					// Verify the mute state was set correctly
					const actualMuted = await this.sonos.getMuted();
					if (actualMuted !== this.isMuted) {
						logger.warn('Mute state mismatch:', {
							expected: this.isMuted,
							actual: actualMuted
						});
						this.isMuted = actualMuted;
						this.showAlert(dialAction, 'Failed to set mute state');
					}

					// Update UI to reflect mute state
					dialAction.setFeedback({ 
						value: {
							value: this.lastKnownVolume,
							opacity: this.isMuted ? 0.5 : 1.0,
						},
						indicator: { 
							value: this.lastKnownVolume,
							opacity: this.isMuted ? 0.5 : 1.0
						}
					});
				} catch (error) {
					logger.error('Failed to toggle mute:', {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined
					});
					this.sonos = null;
					this.showAlert(dialAction, 'Failed to toggle mute');
				}
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

			// If we have a speaker IP, toggle mute state
			if (speakerIp) {
				// Initialize connection if needed
				if (!this.sonos) {
					logger.info('Reconnecting to speaker:', speakerIp);
					this.sonos = new Sonos(speakerIp);
					// Restart polling if it was stopped
					if (!this.pollInterval) {
						this.startPolling(dialAction);
					}
				}

				try {
					// Toggle mute state
					this.isMuted = !this.isMuted;
					await this.sonos.setMuted(this.isMuted);

					// Verify the mute state was set correctly
					const actualMuted = await this.sonos.getMuted();
					if (actualMuted !== this.isMuted) {
						logger.warn('Mute state mismatch:', {
							expected: this.isMuted,
							actual: actualMuted
						});
						this.isMuted = actualMuted;
						this.showAlert(dialAction, 'Failed to set mute state');
					}

					// Update UI to reflect mute state
					dialAction.setFeedback({ 
						value: {
							value: this.lastKnownVolume,
							opacity: this.isMuted ? 0.5 : 1.0,
						},
						indicator: { 
							value: this.lastKnownVolume,
							opacity: this.isMuted ? 0.5 : 1.0
						}
					});
				} catch (error) {
					logger.error('Failed to toggle mute:', {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined
					});
					this.sonos = null;
					this.showAlert(dialAction, 'Failed to toggle mute');
				}
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