import { action, DialAction, DialRotateEvent, SingletonAction, WillAppearEvent, DialUpEvent, TouchTapEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { Sonos } from 'sonos';

/**
 * Sonos Volume Dial action that controls a Sonos speaker's volume.
 */
@action({ UUID: 'com.0xjessel.sonosvolumedial.volume' })
export class SonosVolumeDial extends SingletonAction {
	private sonos: Sonos | null = null;
	private lastKnownVolume: number = 50;
	private isMuted: boolean = false;
	private logger = streamDeck.logger.createScope('SonosVolumeDial');

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

			logger.debug('Initializing with settings:', { speakerIp, value, volumeStep });

			// Initialize display with current or default value
			dialAction.setFeedback({ value, indicator: { value } });
			dialAction.setSettings({ value, volumeStep, speakerIp });

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
					
					logger.debug('Got current state:', { volume, isMuted });
					this.lastKnownVolume = volume;
					this.isMuted = isMuted;
					
					// Update UI with current state
					dialAction.setFeedback({ 
						value: volume, 
						indicator: { value: volume }
					});
					dialAction.setSettings({ ...ev.payload.settings, value: volume });
				} catch (error) {
					logger.error('Failed to get speaker state:', {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined
					});
					this.sonos = null;
				}
			} else {
				logger.warn('No speaker IP configured');
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
			const { ticks } = ev.payload;

			// Calculate new value using the volumeStep setting
			const newValue = Math.max(0, Math.min(100, value + (ticks * volumeStep)));
			logger.debug('Processing rotation:', { 
				currentValue: value,
				ticks,
				volumeStep,
				newValue,
				speakerIp
			});

			// Always update the display immediately for responsiveness
			dialAction.setFeedback({ 
				value: newValue, 
				indicator: { value: newValue }
			});
			dialAction.setSettings({ ...ev.payload.settings, value: newValue });
			this.lastKnownVolume = newValue;

			// If we have a speaker IP, update the speaker volume
			if (speakerIp) {
				// Initialize connection if needed
				if (!this.sonos) {
					logger.info('Reconnecting to speaker:', speakerIp);
					this.sonos = new Sonos(speakerIp);
				}

				try {
					// If speaker is muted, unmute it first and verify
					if (this.isMuted) {
						logger.debug('Unmuting speaker before volume change');
						await this.sonos.setMuted(false);
						
						// Verify unmute was successful
						const isMuted = await this.sonos.getMuted();
						if (isMuted) {
							logger.error('Failed to unmute speaker');
							return;
						}
						
						logger.debug('Speaker unmuted successfully');
						this.isMuted = false;
						
						// Update UI to reflect unmuted state
						dialAction.setFeedback({ 
							value: newValue, 
							indicator: { value: newValue }
						});
					}

					logger.debug('Setting volume:', newValue);
					await this.sonos.setVolume(newValue);
					logger.debug('Volume set successfully');

					// Verify the volume was set correctly
					const actualVolume = await this.sonos.getVolume();
					if (actualVolume !== newValue) {
						logger.warn('Volume mismatch:', {
							expected: newValue,
							actual: actualVolume
						});
					} else {
						logger.debug('Volume verified:', actualVolume);
					}
				} catch (error) {
					logger.error('Volume update failed:', {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined
					});
					this.sonos = null;
				}
			} else {
				logger.warn('No speaker IP configured');
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
				}

				try {
					// Toggle mute state
					this.isMuted = !this.isMuted;
					logger.debug('Setting mute state:', this.isMuted);
					await this.sonos.setMuted(this.isMuted);
					logger.debug('Mute state set successfully');

					// Verify the mute state was set correctly
					const actualMuted = await this.sonos.getMuted();
					if (actualMuted !== this.isMuted) {
						logger.warn('Mute state mismatch:', {
							expected: this.isMuted,
							actual: actualMuted
						});
						this.isMuted = actualMuted;
					} else {
						logger.debug('Mute state verified:', actualMuted);
					}

					// Update UI to reflect mute state
					dialAction.setFeedback({ 
						value: this.lastKnownVolume, 
						indicator: { value: this.lastKnownVolume }
					});
				} catch (error) {
					logger.error('Mute toggle failed:', {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined
					});
					this.sonos = null;
				}
			} else {
				logger.warn('No speaker IP configured');
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
				}

				try {
					// Toggle mute state
					this.isMuted = !this.isMuted;
					logger.debug('Setting mute state:', this.isMuted);
					await this.sonos.setMuted(this.isMuted);
					logger.debug('Mute state set successfully');

					// Verify the mute state was set correctly
					const actualMuted = await this.sonos.getMuted();
					if (actualMuted !== this.isMuted) {
						logger.warn('Mute state mismatch:', {
							expected: this.isMuted,
							actual: actualMuted
						});
						this.isMuted = actualMuted;
					} else {
						logger.debug('Mute state verified:', actualMuted);
					}

					// Update UI to reflect mute state
					dialAction.setFeedback({ 
						value: this.lastKnownVolume, 
						indicator: { value: this.lastKnownVolume }
					});
				} catch (error) {
					logger.error('Mute toggle failed:', {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined
					});
					this.sonos = null;
				}
			} else {
				logger.warn('No speaker IP configured');
			}
		} catch (error) {
			logger.error('Error in onTouchTap:', {
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