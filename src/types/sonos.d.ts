declare module 'sonos' {
    export class Sonos {
        constructor(host: string, port?: number);
        getVolume(): Promise<number>;
        setVolume(volume: number): Promise<void>;
        getMuted(): Promise<boolean>;
        getCurrentState(): Promise<string>;
        togglePlayback(): Promise<boolean>;
        getAllGroups(): Promise<SonosGroup[]>;
        currentTrack(): Promise<SonosTrack>;
        next(): Promise<boolean>;
    }

    export interface SonosGroup {
        Name: string;
        host: string;
        port: number;
        Coordinator: string;
        ZoneGroupMember: ZoneGroupMember[];
    }

    export interface ZoneGroupMember {
        UUID: string;
        ZoneName: string;
        Location: string;
    }

    export interface SonosTrack {
        title: string;
        artist: string;
        album: string;
        albumArtURI: string;
        duration: number;
        position?: number;
    }
    
    export class AsyncDeviceDiscovery {
        discover(options?: { timeout?: number }): Promise<Sonos>;
    }
}