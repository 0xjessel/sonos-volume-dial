import { action, DialDownEvent, DialRotateEvent, DialUpEvent, DidReceiveSettingsEvent, JsonObject, JsonValue, SendToPluginEvent, SingletonAction, TouchTapEvent, WillAppearEvent } from "@elgato/streamdeck";
import { streamDeck } from "@elgato/streamdeck";

/**
 * Settings interface for the Sonos volume control
 */
interface SonosSettings extends JsonObject {
    speakerIp?: string;
    volumeStep?: number;
    currentVolume?: number;
    isMuted?: boolean;
    [key: string]: JsonValue;
}

/**
 * Payload interface for messages from the property inspector
 */
interface PropertyInspectorPayload extends JsonObject {
    type: 'validateIp';
    ip: string;
    [key: string]: JsonValue;
}

/**
 * Sonos Volume Control action that handles dial rotation for volume adjustment
 */
@action({ UUID: "com.0xjessel.sonos-volume-dial.volume" })
export class SonosVolumeControl extends SingletonAction<SonosSettings> {
    // Track if dial is currently pressed
    private isDialPressed = false;

    /**
     * Called when the dial action appears on Stream Deck
     */
    override async onWillAppear(ev: WillAppearEvent<SonosSettings>): Promise<void> {
        const settings = ev.payload.settings;
        let needsUpdate = false;
        
        console.log('Action appearing with initial settings:', settings);
        
        // Initialize settings with defaults if not set
        if (!settings.volumeStep) {
            console.log('Setting default volume step to 2%');
            settings.volumeStep = 2; // Default 2% increment
            needsUpdate = true;
        }
        if (settings.currentVolume === undefined) {
            console.log('Setting default volume to 50%');
            settings.currentVolume = 50; // Default 50% volume
            needsUpdate = true;
        }
        if (settings.isMuted === undefined) {
            console.log('Setting default mute state to false');
            settings.isMuted = false;
            needsUpdate = true;
        }
        // Keep existing speakerIp if set, don't override
        if (settings.speakerIp === undefined) {
            console.log('No IP address found, setting empty default');
            settings.speakerIp = ""; // Empty string as default
            needsUpdate = true;
        } else {
            console.log('Found existing IP address:', settings.speakerIp);
        }
        
        // Only update settings if something changed
        if (needsUpdate) {
            console.log('Updating settings with defaults:', settings);
            await ev.action.setSettings(settings);
        } else {
            console.log('Using existing settings:', settings);
        }

        // Always update the display
        await this.updateVolumeDisplay(ev.action, settings.currentVolume, settings.isMuted);
    }

    /**
     * Called when the dial is rotated
     */
    override async onDialRotate(ev: DialRotateEvent<SonosSettings>): Promise<void> {
        const settings = ev.payload.settings;
        const step = settings.volumeStep ?? 2;
        
        // Don't adjust volume if muted
        if (settings.isMuted) {
            return;
        }
        
        // Calculate new volume based on rotation
        // Positive ticks mean clockwise rotation (volume up)
        const volumeChange = step * ev.payload.ticks;
        const currentVolume = settings.currentVolume ?? 50;
        const newVolume = Math.max(0, Math.min(100, currentVolume + volumeChange));

        // Update settings with new volume
        settings.currentVolume = newVolume;
        await ev.action.setSettings(settings);

        // Update the display
        await this.updateVolumeDisplay(ev.action, newVolume, false);
    }

    /**
     * Called when the dial is pressed
     */
    override async onDialDown(ev: DialDownEvent<SonosSettings>): Promise<void> {
        this.isDialPressed = true;
    }

    /**
     * Called when the dial is released - handles mute/unmute
     */
    override async onDialUp(ev: DialUpEvent<SonosSettings>): Promise<void> {
        // Only toggle if we were the ones who saw the press
        if (!this.isDialPressed) return;
        this.isDialPressed = false;

        const settings = ev.payload.settings;
        settings.isMuted = !settings.isMuted;
        
        await ev.action.setSettings(settings);
        await this.updateVolumeDisplay(ev.action, settings.currentVolume ?? 50, settings.isMuted);
    }

    /**
     * Called when the touchscreen is tapped - shows current volume
     */
    override async onTouchTap(ev: TouchTapEvent<SonosSettings>): Promise<void> {
        const settings = ev.payload.settings;
        await this.updateVolumeDisplay(ev.action, settings.currentVolume ?? 50, settings.isMuted ?? false);
    }

    /**
     * Called when settings are updated in the property inspector
     */
    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosSettings>): Promise<void> {
        const settings = ev.payload.settings;
        console.log('Action received settings update:', settings);
        await this.updateVolumeDisplay(ev.action, settings.currentVolume ?? 50, settings.isMuted ?? false);
    }

    /**
     * Called when a message is received from the property inspector
     */
    override async onSendToPlugin(ev: SendToPluginEvent<PropertyInspectorPayload, SonosSettings>): Promise<void> {
        const { action, payload } = ev;
        
        if (payload.type === 'validateIp') {
            // For testing, just validate IP format
            const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
            const isValidFormat = ipRegex.test(payload.ip);
            
            // Show alert for invalid format
            if (!isValidFormat) {
                await ev.action.showAlert();
            }
        }
    }

    /**
     * Helper method to update the volume display on the dial using the $B1 layout
     */
    private async updateVolumeDisplay(action: any, volume: number, isMuted: boolean): Promise<void> {
        const roundedVolume = Math.round(volume);
        
        // Update the dial display using the $B1 layout
        await action.setFeedback({
            // Title at the top
            title: isMuted ? "MUTED" : `Volume ${roundedVolume}%`,
            
            // Icon in the middle (TODO: implement different icons for muted/unmuted)
            icon: "imgs/actions/volume/icon",
            
            // Value below the icon
            value: isMuted ? "Muted" : `${roundedVolume}%`,
            
            // Progress bar at the bottom
            indicator: {
                value: isMuted ? 0 : volume,
                enabled: true
            }
        });
    }
} 