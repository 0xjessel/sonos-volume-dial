declare module 'sonos' {
    export interface SonosZoneGroupMember {
        UUID: string;
        ZoneName: string;
        Location: string;
        Invisible?: string;
    }

    export interface SonosGroup {
        /** Display name computed by node-sonos (coordinator name, plus " + N" when grouped) */
        Name: string;
        /** Coordinator host (IP address) */
        host: string;
        port: number;
        Coordinator: string;
        ZoneGroupMember: SonosZoneGroupMember[];
    }

    export class Sonos {
        constructor(host: string, port?: number);
        host: string;

        getVolume(): Promise<number>;
        setVolume(volume: number): Promise<void>;
        getMuted(): Promise<boolean>;
        setMuted(muted: boolean): Promise<void>;
        getAllGroups(): Promise<SonosGroup[]>;
    }

    export class AsyncDeviceDiscovery {
        discover(options?: { timeout?: number }): Promise<Sonos>;
        discoverMultiple(options?: { timeout?: number }): Promise<Sonos[]>;
    }
}
