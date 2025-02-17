import streamDeck, { LogLevel } from "@elgato/streamdeck";
import { SonosVolumeControl } from "./actions/sonos-volume";

// Enable trace logging for development
streamDeck.logger.setLevel(LogLevel.TRACE);

// Register the Sonos volume control action
streamDeck.actions.registerAction(new SonosVolumeControl());

// Connect to Stream Deck
streamDeck.connect();
