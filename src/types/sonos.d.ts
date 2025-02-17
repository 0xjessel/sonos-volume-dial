declare module 'sonos' {
    export class Sonos {
        constructor(host: string, port?: number);
        
        getVolume(): Promise<number>;
        setVolume(volume: number): Promise<void>;
        getMuted(): Promise<boolean>;
        setMuted(muted: boolean): Promise<void>;
    }
} 