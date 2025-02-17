import { action, DialAction, DialRotateEvent, SingletonAction, WillAppearEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { Sonos } from 'sonos';

/**
 * Sonos Volume Dial action that controls a Sonos speaker's volume.
 */
@action({ UUID: 'com.0xjessel.sonosvolumedial.volume' })
export class SonosVolumeDial extends SingletonAction {
	private sonos: Sonos | null = null;
	private lastKnownVolume: number = 50;
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
					const volume = await this.sonos.getVolume();
					logger.debug('Got current volume:', volume);
					this.lastKnownVolume = volume;
					dialAction.setFeedback({ value: volume, indicator: { value: volume } });
					dialAction.setSettings({ ...ev.payload.settings, value: volume });
				} catch (error) {
					logger.error('Failed to get volume:', {
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
			dialAction.setFeedback({ value: newValue, indicator: { value: newValue } });
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
}

/**
 * Settings for {@link SonosVolumeDial}.
 */
type SonosVolumeDialSettings = {
	value: number;
	speakerIp?: string;
	volumeStep: number;
};