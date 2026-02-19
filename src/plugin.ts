import streamDeck, { LogLevel } from '@elgato/streamdeck';

import { SonosVolumeDial } from './actions/sonos-volume-dial';
import { SonosGroupVolumeDial } from './actions/sonos-group-volume-dial';

// Set up logging with DEBUG level for development
streamDeck.logger.setLevel(LogLevel.DEBUG);
const logger = streamDeck.logger.createScope('SonosPlugin');
logger.info('Sonos Volume Dial plugin starting...');

// Register the actions.
streamDeck.actions.registerAction(new SonosVolumeDial());
streamDeck.actions.registerAction(new SonosGroupVolumeDial());

// Finally, connect to the Stream Deck.
streamDeck.connect();