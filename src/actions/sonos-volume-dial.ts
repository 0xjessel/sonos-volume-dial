import { action, DialAction, DialRotateEvent, SingletonAction, WillAppearEvent, DialUpEvent, TouchTapEvent, DidReceiveSettingsEvent } from '@elgato/streamdeck';
import streamDeck from '@elgato/streamdeck';
import { Sonos, AsyncDeviceDiscovery, SonosGroup } from 'sonos';

/**
 * Sonos Volume Dial action that controls a Sonos speaker's volume.
 */
@action({ UUID: 'com.0xjessel.sonos-volume-dial.volume' })
export class SonosVolumeDial extends SingletonAction {
	// Constants
	private static readonly POLLING_INTERVAL_MS = 3000;
	private static readonly VOLUME_CHANGE_DEBOUNCE_MS = 500;

	private cachedGroups: SonosGroup[] = [];
	private logger = streamDeck.logger.createScope('SonosVolumeDial');
	private states: Map<string, ActionState> = new Map();

	private playSvg: string = '';
	private pauseSvg: string = '';

	/**
	 * Start polling for speaker state
	 */
	private startPolling(dialAction: DialAction<SonosVolumeDialSettings>) {
		const logger = this.logger.createScope('Polling');
		const state = this.getState(dialAction.id);

		if (state.pollInterval?.active) {
			logger.debug('Polling already active, skipping');
			return;
		}

		if (state.pollInterval) {
			state.pollInterval.active = false;
			state.pollInterval = null;
		}

		if (state.pollTimeoutId) {
			clearTimeout(state.pollTimeoutId);
			state.pollTimeoutId = null;
		}

		state.currentAction = dialAction;

		if (!state.currentAction || !state.currentSettings) {
			logger.debug('Missing required state, cannot start polling');
			return;
		}

		state.pollInterval = { active: true };
		logger.debug('Starting polling');
		this.pollWithDelay(dialAction.id, logger);
	}

	/**
	 * Show an alert to the user
	 */
	private showAlert(action: DialAction<SonosVolumeDialSettings>, message: string) {
		action.showAlert();
		this.logger.error(message);
	}

	/**
	  * Get or create state for an action instance
	  */
	private getState(contextId: string): ActionState {
		if (!this.states.has(contextId)) {
			this.states.set(contextId, {
				sonos: null,
				lastKnownVolume: 50,
				isPaused: false,
				isRotating: false,
				pollInterval: null,
				pollTimeoutId: null,
				volumeChangeTimeout: null,
				currentAction: null,
				currentSettings: null,
				currentTrackTitle: '',
				currentArtist: '',
				currentAlbumArtBase64: '',
				currentDuration: 1,
				lastTrackTitle: '',
				lastPollTime: 0,
				lastPosition: 0,
				tickInterval: null
			});
		}
		return this.states.get(contextId)!;
	}

	/**
	 * Load play and pause SVG icons from disk
	 */
	private async loadIcons(): Promise<void> {
		const logger = this.logger.createScope('Icons');
		try {
			const fs = await import('fs');
			const path = await import('path');
			const url = await import('url');
			const base = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'imgs');
			const playData = fs.readFileSync(path.join(base, 'play.svg'));
			const pauseData = fs.readFileSync(path.join(base, 'pause.svg'));
			this.playSvg = `data:image/svg+xml;base64,${playData.toString('base64')}`;
			this.pauseSvg = `data:image/svg+xml;base64,${pauseData.toString('base64')}`;
			logger.info('Icons loaded successfully');
		} catch (error) {
			logger.error('Failed to load icons:', {
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	/**
	  * Get the play state icon based on paused state
	  */
	private getPlayStateIcon(isPaused: boolean): string {
		return isPaused ? this.playSvg : this.pauseSvg;
	}

	/**
	  * Start a 1-second timer to update elapsed time display
	  */
	private startTickTimer(contextId: string): void {
		const state = this.getState(contextId);
		if (state.tickInterval) return;
		if (state.isPaused) return;

		state.tickInterval = setInterval(() => {
			const state = this.getState(contextId);
			if (!state.currentAction || !state.currentSettings) return;
			if (state.isRotating) return;
			if (state.isPaused) {
				clearInterval(state.tickInterval!);
				state.tickInterval = null;
				return;
			}
			const elapsed = state.lastPosition + Math.round((Date.now() - state.lastPollTime) / 1000);
			const clamped = Math.min(elapsed, state.currentDuration);

			state.currentAction.setFeedback({
				elapsed: this.formatTime(clamped)
			});
		}, 1000);
	}

	/**
	* Discover all Sonos groups on the network
	*/
	private async discoverGroups(): Promise<SonosGroup[]> {
		const logger = this.logger.createScope('Discovery');
		try {
			logger.info('Starting Sonos discovery...');
			const discovery = new AsyncDeviceDiscovery();
			const device = await discovery.discover({ timeout: 5000 });
			const groups = await device.getAllGroups();
			logger.info('Found groups:', groups.map(g => g.Name));
			this.cachedGroups = groups;
			return groups;
		} catch (error) {
			logger.error('Discovery failed:', {
				error: error instanceof Error ? error.message : String(error)
			});
			return [];
		}
	}

	/**
	 * Get a Sonos connection for a named group
	*/
	private async getGroupConnection(groupName: string): Promise<Sonos | null> {
		const logger = this.logger.createScope('GroupConnection');
		try {
			// Use cached groups first, rediscover if empty
			if (this.cachedGroups.length === 0) {
				await this.discoverGroups();
			}
			const group = this.cachedGroups.find(g => g.Name === groupName) || this.cachedGroups.find(g => g.Name.startsWith(groupName.split(' + ')[0]));
			if (!group) {
				logger.error('Group not found:', groupName);
				return null;
			}
			return new Sonos(group.host, group.port);
		} catch (error) {
			logger.error('Failed to get group connection:', {
				error: error instanceof Error ? error.message : String(error)
			});
			return null;
		}
	}

	/**
	 * Format seconds as m:ss
	  */
	private formatTime(seconds: number): string {
		const mins = Math.floor(seconds / 60);
		const secs = Math.floor(seconds % 60);
		return `${mins}:${secs.toString().padStart(2, '0')}`;
	}

	/**
	 * Fetch album art and return as base64 string
	 */
	private async fetchAlbumArt(albumArtURI: string, speakerHost: string): Promise<string> {
		const logger = this.logger.createScope('AlbumArt');
		try {
			if (!albumArtURI) return '';
			const url = albumArtURI.startsWith('http')
				? albumArtURI
				: `http://${speakerHost}:1400${albumArtURI}`;
			const response = await fetch(url);
			if (!response.ok) return '';
			const buffer = await response.arrayBuffer();
			const base64 = Buffer.from(buffer).toString('base64');
			const mimeType = response.headers.get('content-type') || 'image/jpeg';
			return `data:${mimeType};base64,${base64}`;
		} catch (error) {
			logger.error('Failed to fetch album art:', {
				error: error instanceof Error ? error.message : String(error)
			});
			return '';
		}
	}

	/**
	 * Self-scheduling poll function that maintains consistent spacing
	 */
	private async pollWithDelay(contextId: string, logger: ReturnType<typeof streamDeck.logger.createScope>) {
		const state = this.getState(contextId);

		if (!state.pollInterval?.active) {
			return;
		}

		try {
			if (!state.currentAction || !state.currentSettings) {
				logger.debug('No current action or settings, stopping polling');
				this.stopPolling(contextId);
				return;
			}

			try {
				if (!state.sonos) {
					if (state.currentSettings.groupName) {
						logger.info('Reconnecting to group:', state.currentSettings.groupName);
						state.sonos = await this.getGroupConnection(state.currentSettings.groupName);
						if (!state.sonos) {
							logger.debug('Could not find group, stopping polling');
							this.stopPolling(contextId);
							return;
						}
					} else {
						logger.debug('No group configured, stopping polling');
						this.stopPolling(contextId);
						return;
					}
				}

				const [volume, currentState, track] = await Promise.all([
					state.sonos.getVolume(),
					state.sonos.getCurrentState(),
					state.sonos.currentTrack()
				]);
				const isPaused = currentState === 'paused' || currentState === 'stopped';

				// Fetch album art only when track changes
				const trackChanged = track?.title !== state.lastTrackTitle;
				if (track?.title && trackChanged) {
					state.lastTrackTitle = track.title;
					state.currentTrackTitle = track.title || '';
					state.currentArtist = track.artist || '';
					state.currentDuration = track.duration || 1;
					const group = this.cachedGroups.find(g => g.Name === state.currentSettings?.groupName);
					if (group && track.albumArtURI) {
						state.currentAlbumArtBase64 = await this.fetchAlbumArt(track.albumArtURI, group.host);
					}
				}

				if (!state.isRotating) {
					state.lastKnownVolume = volume;
					state.isPaused = isPaused;
					if (!isPaused) {
						state.lastPosition = track?.position || 0;
						state.lastPollTime = Date.now();
					}

					state.currentAction.setFeedback({
						albumArt: state.currentAlbumArtBase64,
						groupName: state.currentSettings?.groupName || '',
						playState: this.getPlayStateIcon(isPaused),
						trackTitle: state.currentTrackTitle,
						artistName: state.currentArtist,
						elapsed: this.formatTime(track?.position || 0),
						progress: state.currentDuration > 0
							? Math.round((track?.position || 0) / state.currentDuration * 100)
							: 0,
						duration: this.formatTime(state.currentDuration)
					});
					state.currentAction.setSettings({ ...state.currentSettings, value: volume });
					this.startTickTimer(contextId);
				}
			} catch (error) {
				logger.error('Failed to poll speaker state:', {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined
				});
				state.sonos = null;
			}
		} finally {
			if (state.pollInterval?.active) {
				if (state.pollTimeoutId) {
					clearTimeout(state.pollTimeoutId);
				}
				state.pollTimeoutId = setTimeout(() => {
					state.pollTimeoutId = null;
					if (state.pollInterval?.active) {
						this.pollWithDelay(contextId, logger);
					}
				}, SonosVolumeDial.POLLING_INTERVAL_MS);
			}
		}
	}

	/**
	 * Stop polling for speaker state
	 */
	private stopPolling(contextId: string) {
		const state = this.states.get(contextId);
		if (!state) return;

		if (state.pollInterval) {
			this.logger.debug('Stopping polling');
			state.pollInterval.active = false;
			state.pollInterval = null;
		}
		if (state.pollTimeoutId) {
			clearTimeout(state.pollTimeoutId);
			state.pollTimeoutId = null;
		}
		if (state.tickInterval) {
			clearInterval(state.tickInterval);
			state.tickInterval = null;
		}
		state.currentAction = null;
		state.currentSettings = null;
	}

	/**
	  * Handle messages from the property inspector
	  */
	override async onSendToPlugin(ev: any): Promise<void> {
		const logger = this.logger.createScope('SendToPlugin');
		try {
			if (ev.payload.event === 'getGroups') {
				logger.info('Property inspector requested group list');
				const groups = await this.discoverGroups();
				const groupNames = groups.map(g => g.Name);
				await streamDeck.ui.current?.sendToPropertyInspector({
					event: 'groupList',
					groups: groupNames
				});
			}
		} catch (error) {
			logger.error('Error in onSendToPlugin:', {
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	/**
	 * Clean up when the action is removed
	 */
	override onWillDisappear(ev: any): void {
		const state = this.states.get(ev.action.id);
		if (!state) return;

		if (state.volumeChangeTimeout) {
			clearTimeout(state.volumeChangeTimeout);
			state.volumeChangeTimeout = null;
		}
		if (state.tickInterval) {
			clearInterval(state.tickInterval);
			state.tickInterval = null;
		}
		this.stopPolling(ev.action.id);
		this.states.delete(ev.action.id);
	}

	/**
	 * Sets the initial value when the action appears on Stream Deck.
	 */
	override async onWillAppear(ev: WillAppearEvent<SonosVolumeDialSettings>): Promise<void> {
		const logger = this.logger.createScope('WillAppear');

		try {
			if (!ev.action.isDial()) return;

			if (!this.playSvg) {
				await this.loadIcons();
			}

			const dialAction = ev.action as DialAction<SonosVolumeDialSettings>;
			const state = this.getState(dialAction.id);
			const { groupName, value = 50, volumeStep = 5 } = ev.payload.settings;

			state.currentAction = dialAction;
			state.currentSettings = ev.payload.settings;

			await dialAction.setFeedbackLayout('layouts/track-info.json');
			dialAction.setFeedback({
				albumArt: '',
				groupName: groupName || '',
				playState: this.getPlayStateIcon(state.isPaused),
				trackTitle: '',
				artistName: '',
				elapsed: '0:00',
				progress: 0,
				duration: '0:00'
			});

			if (groupName) {
				logger.info('Connecting to Sonos group:', groupName);
				state.sonos = await this.getGroupConnection(groupName);

				if (!state.sonos) {
					logger.error('Could not connect to group:', groupName);
					this.showAlert(dialAction, 'Could not find Sonos group');
					return;
				}

				try {
					const [volume, currentState] = await Promise.all([
						state.sonos.getVolume(),
						state.sonos.getCurrentState()
					]);
					const isPaused = currentState === 'paused' || currentState === 'stopped';

					state.lastKnownVolume = volume;
					state.isPaused = isPaused;

					await dialAction.setFeedbackLayout('layouts/track-info.json');
					dialAction.setFeedback({
						albumArt: '',
						groupName: groupName || '',
						playState: this.getPlayStateIcon(state.isPaused),
						trackTitle: '',
						artistName: '',
						elapsed: '0:00',
						progress: 0,
						duration: '0:00'
					});

					dialAction.setSettings({ groupName, volumeStep, value: volume });
					this.startPolling(dialAction);
				} catch (error) {
					logger.error('Failed to connect to speaker:', {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined
					});
					state.sonos = null;
					this.showAlert(dialAction, 'Failed to connect to speaker');
					dialAction.setSettings({ groupName, volumeStep, value });
				}
			} else {
				logger.warn('No group configured');
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
		const logger = this.logger.createScope('DialRotate');
		const dialAction = ev.action as DialAction<SonosVolumeDialSettings>;
		const state = this.getState(dialAction.id);

		try {
			const { groupName, value = state.lastKnownVolume, volumeStep = 5 } = ev.payload.settings;

			state.isRotating = true;
			state.currentSettings = ev.payload.settings;

			const { ticks } = ev.payload;
			const newValue = Math.max(0, Math.min(100, value + (ticks * volumeStep)));

			await dialAction.setFeedbackLayout('layouts/volume.json');
			dialAction.setFeedback({
				albumArt: state.currentAlbumArtBase64,
				volumeNumber: String(newValue),
				volumeLabel: 'volume',
				volumeBar: newValue
			});
			dialAction.setSettings({ ...state.currentSettings, value: newValue });
			state.lastKnownVolume = newValue;

			if (state.volumeChangeTimeout) {
				clearTimeout(state.volumeChangeTimeout);
				state.volumeChangeTimeout = null;
			}

			if (groupName) {
				state.volumeChangeTimeout = setTimeout(async () => {
					try {
						if (!state.sonos) {
							logger.info('Reconnecting to group:', groupName);
							state.sonos = await this.getGroupConnection(groupName);
							if (!state.sonos) {
								throw new Error(`Could not find group: ${groupName}`);
							}
						}

						if (state.isPaused) {
							await state.sonos.togglePlayback();
							state.isPaused = false;
						}

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
						state.isRotating = false;
						await dialAction.setFeedbackLayout('layouts/track-info.json');
						this.startPolling(dialAction);
					}
				}, SonosVolumeDial.VOLUME_CHANGE_DEBOUNCE_MS);
			} else {
				logger.warn('No group configured');
				this.showAlert(dialAction, 'No group configured');
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
		const logger = this.logger.createScope('DialUp');

		try {
			const dialAction = ev.action as DialAction<SonosVolumeDialSettings>;
			const state = this.getState(dialAction.id);
			const { groupName } = ev.payload.settings;

			const newPausedState = !state.isPaused;
			state.isPaused = newPausedState;
			dialAction.setFeedback({
				playState: this.getPlayStateIcon(newPausedState),
			});

			if (groupName) {
				Promise.resolve().then(async () => {
					try {
						if (!state.sonos) {
							logger.info('Reconnecting to group:', groupName);
							state.sonos = await this.getGroupConnection(groupName);
							if (!state.sonos) {
								throw new Error(`Could not find group: ${groupName}`);
							}
							if (!state.pollInterval) {
								this.startPolling(dialAction);
							}
						}

						await state.sonos.togglePlayback();
					} catch (error) {
						logger.error('Failed to toggle playback:', {
							error: error instanceof Error ? error.message : String(error),
							stack: error instanceof Error ? error.stack : undefined
						});
						state.sonos = null;
						this.showAlert(dialAction, 'Failed to toggle playback');
					}
				});
			} else {
				logger.warn('No group configured');
				this.showAlert(dialAction, 'No group configured');
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
		const logger = this.logger.createScope('TouchTap');

		try {
			const dialAction = ev.action as DialAction<SonosVolumeDialSettings>;
			const state = this.getState(dialAction.id);
			const { groupName } = ev.payload.settings;

			if (groupName) {
				Promise.resolve().then(async () => {
					try {
						if (!state.sonos) {
							logger.info('Reconnecting to group:', groupName);
							state.sonos = await this.getGroupConnection(groupName);
							if (!state.sonos) {
								throw new Error(`Could not find group: ${groupName}`);
							}
							if (!state.pollInterval) {
								this.startPolling(dialAction);
							}
						}

						await state.sonos.next();
					} catch (error) {
						logger.error('Failed to skip to next track::', {
							error: error instanceof Error ? error.message : String(error),
							stack: error instanceof Error ? error.stack : undefined
						});
						state.sonos = null;
						this.showAlert(dialAction, 'Failed to skip to next track:');
					}
				});
			} else {
				logger.warn('No group configured');
				this.showAlert(dialAction, 'No group configured');
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
			const state = this.getState(dialAction.id);
			const { groupName, value = state.lastKnownVolume, volumeStep = 5 } = ev.payload.settings;

			const previousGroupName = state.currentSettings?.groupName;
			state.currentSettings = ev.payload.settings;

			if (groupName !== previousGroupName) {
				state.sonos = null;
				this.stopPolling(dialAction.id);
				state.currentAction = dialAction;
				state.currentSettings = ev.payload.settings;
				
				if (groupName) {
					logger.info('Connecting to new group:', groupName);
					state.sonos = await this.getGroupConnection(groupName);
					if (!state.sonos) {
						logger.error('Could not connect to group:', groupName);
						this.showAlert(dialAction, 'Could not find Sonos group');
						return;
					}
					try {
						const [volume, currentState] = await Promise.all([
							state.sonos.getVolume(),
							state.sonos.getCurrentState()
						]);
						const isPaused = currentState === 'paused' || currentState === 'stopped';

						state.lastKnownVolume = volume;
						state.isPaused = isPaused;

						await dialAction.setFeedbackLayout('layouts/track-info.json');
						dialAction.setFeedback({
							albumArt: '',
							groupName: groupName || '',
							playState: this.getPlayStateIcon(isPaused),
							trackTitle: '',
							artistName: '',
							elapsed: '0:00',
							progress: 0,
							duration: '0:00'
						});
						dialAction.setSettings({ ...ev.payload.settings, value: volume });
						this.startPolling(dialAction);
					} catch (error) {
						logger.error('Failed to connect to new group:', {
							error: error instanceof Error ? error.message : String(error),
							stack: error instanceof Error ? error.stack : undefined
						});
						state.sonos = null;
						this.showAlert(dialAction, 'Failed to connect to group');
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
	groupName?: string;
	volumeStep: number;
};
type ActionState = {
	sonos: Sonos | null;
	lastKnownVolume: number;
	isPaused: boolean;
	isRotating: boolean;
	pollInterval: { active: boolean } | null;
	pollTimeoutId: NodeJS.Timeout | null;
	volumeChangeTimeout: NodeJS.Timeout | null;
	currentAction: DialAction<SonosVolumeDialSettings> | null;
	currentSettings: SonosVolumeDialSettings | null;
	currentTrackTitle: string;
	currentArtist: string;
	currentAlbumArtBase64: string;
	currentDuration: number;
	lastTrackTitle: string;
	lastPollTime: number;
	lastPosition: number;
	tickInterval: NodeJS.Timeout | null;
};