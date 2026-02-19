import { action, DialAction, DialRotateEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DialUpEvent, TouchTapEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { Sonos } from 'sonos';

type SpeakerEntry = {
	sonos: Sonos;
	ip: string;
	offset: number;
};

/**
 * Per-instance state for each group dial action, keyed by action ID.
 */
type InstanceState = {
	speakers: SpeakerEntry[];
	lastKnownVolume: number;
	isMuted: boolean;
	pollInterval: { active: boolean } | null;
	pollTimeoutId: NodeJS.Timeout | null;
	currentAction: DialAction<SonosGroupVolumeDialSettings> | null;
	currentSettings: SonosGroupVolumeDialSettings | null;
	volumeChangeTimeout: NodeJS.Timeout | null;
	isRotating: boolean;
};

/**
 * Sonos Group Volume Dial action that controls multiple Sonos speakers' volume simultaneously.
 */
@action({ UUID: 'com.0xjessel.sonos-volume-dial.group-volume' })
export class SonosGroupVolumeDial extends SingletonAction {
	private static readonly POLLING_INTERVAL_MS = 3000;
	private static readonly VOLUME_CHANGE_DEBOUNCE_MS = 500;

	private logger = streamDeck.logger.createScope('SonosGroupVolumeDial');
	private instances = new Map<string, InstanceState>();

	private getState(id: string): InstanceState {
		let state = this.instances.get(id);
		if (!state) {
			state = {
				speakers: [],
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

	private parseSpeakers(settings: SonosGroupVolumeDialSettings): { ip: string; offset: number }[] {
		if (!settings.speakerIps) return [];
		return settings.speakerIps
			.split(',')
			.map(entry => entry.trim())
			.filter(entry => entry.length > 0)
			.map(entry => {
				// Format: "IP:offset" e.g. "192.168.1.100:+5" or just "192.168.1.100"
				const colonIdx = entry.lastIndexOf(':');
				// Check if there's a colon after the IP (not part of the IP itself)
				if (colonIdx > 0) {
					const possibleIp = entry.substring(0, colonIdx);
					const possibleOffset = entry.substring(colonIdx + 1);
					const offsetNum = parseInt(possibleOffset, 10);
					if (!isNaN(offsetNum) && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(possibleIp)) {
						return { ip: possibleIp, offset: offsetNum };
					}
				}
				return { ip: entry, offset: 0 };
			});
	}

	private connectSpeakers(state: InstanceState, entries: { ip: string; offset: number }[]) {
		state.speakers = entries.map(e => ({ sonos: new Sonos(e.ip), ip: e.ip, offset: e.offset }));
	}

	/** Clamp volume to 0-100 range */
	private clampVolume(vol: number): number {
		return Math.max(0, Math.min(100, vol));
	}

	private startPolling(dialAction: DialAction<SonosGroupVolumeDialSettings>) {
		const actionId = dialAction.id;
		const state = this.getState(actionId);
		const logger = this.logger.createScope(`Polling[${actionId}]`);

		if (state.pollInterval?.active) return;

		if (state.pollInterval) {
			state.pollInterval.active = false;
			state.pollInterval = null;
		}
		if (state.pollTimeoutId) {
			clearTimeout(state.pollTimeoutId);
			state.pollTimeoutId = null;
		}

		state.currentAction = dialAction;

		if (!state.currentAction || !state.currentSettings || state.speakers.length === 0) return;

		state.pollInterval = { active: true };
		this.pollWithDelay(actionId, logger);
	}

	private showAlert(action: DialAction<SonosGroupVolumeDialSettings>, message: string) {
		action.showAlert();
		this.logger.error(message);
	}

	private async pollWithDelay(actionId: string, logger: ReturnType<typeof streamDeck.logger.createScope>) {
		const state = this.getState(actionId);

		if (!state.pollInterval?.active) return;

		try {
			if (!state.currentAction || !state.currentSettings) {
				this.stopPolling(actionId);
				return;
			}

			// Reconnect if no speakers
			if (state.speakers.length === 0) {
				const entries = this.parseSpeakers(state.currentSettings);
				if (entries.length === 0) {
					this.stopPolling(actionId);
					return;
				}
				this.connectSpeakers(state, entries);
			}

			try {
				// Poll the first speaker as the reference for volume display, subtract its offset to get base volume
				const [rawVolume, isMuted] = await Promise.all([
					state.speakers[0].sonos.getVolume(),
					state.speakers[0].sonos.getMuted()
				]);
				const volume = this.clampVolume(rawVolume - state.speakers[0].offset);

				if ((volume !== state.lastKnownVolume || isMuted !== state.isMuted) && !state.isRotating) {
					state.lastKnownVolume = volume;
					state.isMuted = isMuted;

					state.currentAction.setFeedback({
						value: { value: volume, opacity: isMuted ? 0.5 : 1.0 },
						indicator: { value: volume, opacity: isMuted ? 0.5 : 1.0 }
					});
					state.currentAction.setSettings({ ...state.currentSettings, value: volume });
				}
			} catch (error) {
				logger.error('Failed to poll speaker state:', {
					error: error instanceof Error ? error.message : String(error)
				});
				state.speakers = [];
			}
		} finally {
			if (state.pollInterval?.active) {
				if (state.pollTimeoutId) clearTimeout(state.pollTimeoutId);
				state.pollTimeoutId = setTimeout(() => {
					state.pollTimeoutId = null;
					if (state.pollInterval?.active) this.pollWithDelay(actionId, logger);
				}, SonosGroupVolumeDial.POLLING_INTERVAL_MS);
			}
		}
	}

	private stopPolling(actionId: string) {
		const state = this.instances.get(actionId);
		if (!state) return;

		if (state.pollInterval) {
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

	override onWillDisappear(ev: WillDisappearEvent<SonosGroupVolumeDialSettings>): void {
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

	override async onWillAppear(ev: WillAppearEvent<SonosGroupVolumeDialSettings>): Promise<void> {
		const actionId = ev.action.id;
		const logger = this.logger.createScope(`WillAppear[${actionId}]`);

		try {
			if (!ev.action.isDial()) return;

			const dialAction = ev.action as DialAction<SonosGroupVolumeDialSettings>;
			const state = this.getState(actionId);
			const { value = 50, volumeStep = 5 } = ev.payload.settings;

			state.currentAction = dialAction;
			state.currentSettings = ev.payload.settings;

			dialAction.setFeedback({
				value: { value, opacity: state.isMuted ? 0.5 : 1.0 },
				indicator: { value, opacity: state.isMuted ? 0.5 : 1.0 },
			});

			const entries = this.parseSpeakers(ev.payload.settings);
			if (entries.length > 0) {
				logger.info('Connecting to Sonos speakers:', entries.map(e => `${e.ip}:${e.offset}`).join(', '));
				this.connectSpeakers(state, entries);

				try {
					const [rawVolume, isMuted] = await Promise.all([
						state.speakers[0].sonos.getVolume(),
						state.speakers[0].sonos.getMuted()
					]);
					const volume = this.clampVolume(rawVolume - state.speakers[0].offset);

					state.lastKnownVolume = volume;
					state.isMuted = isMuted;

					dialAction.setFeedback({
						value: { value: volume, opacity: isMuted ? 0.5 : 1.0 },
						indicator: { value: volume, opacity: isMuted ? 0.5 : 1.0 }
					});
					dialAction.setSettings({ ...ev.payload.settings, value: volume });
					this.startPolling(dialAction);
				} catch (error) {
					logger.error('Failed to connect to speakers:', {
						error: error instanceof Error ? error.message : String(error)
					});
					state.speakers = [];
					this.showAlert(dialAction, 'Failed to connect to speakers');
					dialAction.setSettings({ ...ev.payload.settings, value });
				}
			} else {
				logger.warn('No speaker IPs configured');
				dialAction.setSettings({ ...ev.payload.settings, value });
			}
		} catch (error) {
			logger.error('Error in onWillAppear:', {
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	override async onDialRotate(ev: DialRotateEvent<SonosGroupVolumeDialSettings>): Promise<void> {
		const actionId = ev.action.id;
		const logger = this.logger.createScope(`DialRotate[${actionId}]`);
		const dialAction = ev.action as DialAction<SonosGroupVolumeDialSettings>;
		const state = this.getState(actionId);

		try {
			const { value = state.lastKnownVolume, volumeStep = 5 } = ev.payload.settings;

			state.isRotating = true;
			state.currentSettings = ev.payload.settings;

			const { ticks } = ev.payload;
			const newValue = Math.max(0, Math.min(100, value + (ticks * volumeStep)));

			dialAction.setFeedback({
				value: { value: newValue, opacity: state.isMuted ? 0.5 : 1.0 },
				indicator: { value: newValue, opacity: state.isMuted ? 0.5 : 1.0 }
			});
			dialAction.setSettings({ ...state.currentSettings, value: newValue });
			state.lastKnownVolume = newValue;

			if (state.volumeChangeTimeout) {
				clearTimeout(state.volumeChangeTimeout);
				state.volumeChangeTimeout = null;
			}

			const entries = this.parseSpeakers(ev.payload.settings);
			if (entries.length > 0) {
				state.volumeChangeTimeout = setTimeout(async () => {
					try {
						if (state.speakers.length === 0) {
							this.connectSpeakers(state, entries);
						}

						if (state.isMuted) {
							await Promise.all(state.speakers.map(s => s.sonos.setMuted(false)));
							state.isMuted = false;
						}

						await Promise.all(state.speakers.map(s =>
							s.sonos.setVolume(this.clampVolume(newValue + s.offset))
						));
						logger.debug('Volume set to', newValue, '(with offsets) on all speakers');
					} catch (error) {
						logger.error('Failed to update volume:', {
							error: error instanceof Error ? error.message : String(error)
						});
						state.speakers = [];
						this.showAlert(dialAction, 'Failed to update volume');
					} finally {
						state.isRotating = false;
						this.startPolling(dialAction);
					}
				}, SonosGroupVolumeDial.VOLUME_CHANGE_DEBOUNCE_MS);
			} else {
				this.showAlert(dialAction, 'No speaker IPs configured');
				state.isRotating = false;
			}
		} catch (error) {
			logger.error('Error in onDialRotate:', {
				error: error instanceof Error ? error.message : String(error)
			});
			state.isRotating = false;
		}
	}

	override async onDialUp(ev: DialUpEvent<SonosGroupVolumeDialSettings>): Promise<void> {
		const actionId = ev.action.id;
		const logger = this.logger.createScope(`DialUp[${actionId}]`);

		try {
			const dialAction = ev.action as DialAction<SonosGroupVolumeDialSettings>;
			const state = this.getState(actionId);

			const newMutedState = !state.isMuted;
			state.isMuted = newMutedState;
			dialAction.setFeedback({
				value: { value: state.lastKnownVolume, opacity: newMutedState ? 0.5 : 1.0 },
				indicator: { value: state.lastKnownVolume, opacity: newMutedState ? 0.5 : 1.0 }
			});

			const entries = this.parseSpeakers(ev.payload.settings);
			if (entries.length > 0) {
				Promise.resolve().then(async () => {
					try {
						if (state.speakers.length === 0) {
							this.connectSpeakers(state, entries);
							if (!state.pollInterval) this.startPolling(dialAction);
						}
						await Promise.all(state.speakers.map(s => s.sonos.setMuted(newMutedState)));
					} catch (error) {
						logger.error('Failed to toggle mute:', {
							error: error instanceof Error ? error.message : String(error)
						});
						state.speakers = [];
						this.showAlert(dialAction, 'Failed to toggle mute');
					}
				});
			} else {
				this.showAlert(dialAction, 'No speaker IPs configured');
			}
		} catch (error) {
			logger.error('Error in onDialUp:', {
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	override async onTouchTap(ev: TouchTapEvent<SonosGroupVolumeDialSettings>): Promise<void> {
		const actionId = ev.action.id;
		const logger = this.logger.createScope(`TouchTap[${actionId}]`);

		try {
			const dialAction = ev.action as DialAction<SonosGroupVolumeDialSettings>;
			const state = this.getState(actionId);

			const newMutedState = !state.isMuted;
			state.isMuted = newMutedState;
			dialAction.setFeedback({
				value: { value: state.lastKnownVolume, opacity: newMutedState ? 0.5 : 1.0 },
				indicator: { value: state.lastKnownVolume, opacity: newMutedState ? 0.5 : 1.0 }
			});

			const entries = this.parseSpeakers(ev.payload.settings);
			if (entries.length > 0) {
				Promise.resolve().then(async () => {
					try {
						if (state.speakers.length === 0) {
							this.connectSpeakers(state, entries);
							if (!state.pollInterval) this.startPolling(dialAction);
						}
						await Promise.all(state.speakers.map(s => s.sonos.setMuted(newMutedState)));
					} catch (error) {
						logger.error('Failed to toggle mute:', {
							error: error instanceof Error ? error.message : String(error)
						});
						state.speakers = [];
						this.showAlert(dialAction, 'Failed to toggle mute');
					}
				});
			} else {
				this.showAlert(dialAction, 'No speaker IPs configured');
			}
		} catch (error) {
			logger.error('Error in onTouchTap:', {
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosGroupVolumeDialSettings>): Promise<void> {
		const actionId = ev.action.id;
		const logger = this.logger.createScope(`DidReceiveSettings[${actionId}]`);

		try {
			if (!ev.action.isDial()) return;

			const dialAction = ev.action as DialAction<SonosGroupVolumeDialSettings>;
			const state = this.getState(actionId);

			const previousIps = state.currentSettings?.speakerIps;
			state.currentSettings = ev.payload.settings;

			if (ev.payload.settings.speakerIps !== previousIps) {
				state.speakers = [];
				this.stopPolling(actionId);

				const entries = this.parseSpeakers(ev.payload.settings);
				if (entries.length > 0) {
					logger.info('Connecting to speakers:', entries.map(e => `${e.ip}:${e.offset}`).join(', '));
					this.connectSpeakers(state, entries);

					try {
						const [rawVolume, isMuted] = await Promise.all([
							state.speakers[0].sonos.getVolume(),
							state.speakers[0].sonos.getMuted()
						]);
						const volume = this.clampVolume(rawVolume - state.speakers[0].offset);

						state.lastKnownVolume = volume;
						state.isMuted = isMuted;

						dialAction.setFeedback({
							value: { value: volume, opacity: isMuted ? 0.5 : 1.0 },
							indicator: { value: volume, opacity: isMuted ? 0.5 : 1.0 }
						});
						dialAction.setSettings({ ...ev.payload.settings, value: volume });
						this.startPolling(dialAction);
					} catch (error) {
						logger.error('Failed to connect to speakers:', {
							error: error instanceof Error ? error.message : String(error)
						});
						state.speakers = [];
						this.showAlert(dialAction, 'Failed to connect to speakers');
					}
				}
			}
		} catch (error) {
			logger.error('Error in onDidReceiveSettings:', {
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}
}

/**
 * Settings for {@link SonosGroupVolumeDial}.
 */
type SonosGroupVolumeDialSettings = {
	value: number;
	speakerIps?: string;
	volumeStep: number;
};
