# Sonos Volume Dial

A Stream Deck+ plugin that lets you control your Sonos speaker's volume using the Stream Deck+ dial. Seamlessly adjust volume, mute/unmute, and get real-time feedback directly on your Stream Deck+.

![Stream Deck+ Sonos Volume Control](com.0xjessel.sonos-volume-dial.sdPlugin/imgs/plugin/icon.png)

## Features

- Control Sonos speaker volume using the Stream Deck+ dial
- Mute/unmute by pressing the dial or tapping the touch screen
- Configure volume step size (1%, 2%, 5%, or 10%)
- Real-time volume indicator on the touchscreen display
- Works with any Sonos speaker on your local network

## Requirements

- Stream Deck+
- Stream Deck software 6.4 or later
- macOS 12+ or Windows 10+
- Sonos speaker on your local network

## Installation

### For Users

1. Download the latest release from the [releases page](https://github.com/0xjessel/sonos-volume-dial/releases)
2. Double-click the `.streamDeckPlugin` file to install
3. Find your Sonos speaker's IP address:
   - Open the Sonos app
   - Go to Settings > System > About My System
   - Find your speaker in the list and note its IP address
4. Add the Sonos Volume Dial action to your Stream Deck+
5. Enter your speaker's IP address in the action settings
6. Optionally adjust the volume step size (default: 5%)

### For Developers

```bash
# Clone the repository
git clone https://github.com/0xjessel/sonos-volume-dial.git
cd sonos-volume-dial

# Install dependencies
npm install

# Build the plugin
npm run build

# Watch for changes during development
npm run watch

# Enable developer mode
streamdeck dev

# Link the plugin to Stream Deck
streamdeck link com.0xjessel.sonos-volume-dial.sdPlugin

# Make changes and reload plugin
streamdeck restart com.0xjessel.sonos-volume-dial.sdPlugin
```

## Usage

- **Rotate dial**: Adjust volume up/down
- **Press dial**: Toggle mute
- **Tap screen**: Toggle mute
- Dimmed visuals indicate if speaker is muted
- Current volume level shown on dial

## Development

Requirements:

- Node.js 20 or later
- npm or yarn
- Stream Deck software

## Testing Your Sonos Connection

Before using the Stream Deck plugin, you can test your connection to your Sonos speaker using the included test script.

### Prerequisites

- Node.js installed
- Your Sonos speaker's IP address (you can find this in the Sonos app under Settings > System > About My System)

### Running the Test

1. Edit `scripts/test-sonos-connection.ts` and replace `192.168.1.xxx` with your speaker's IP address
2. Run the test using:
   ```bash
   npm run test-sonos
   ```

The test script will:

1. Connect to your speaker
2. Get the initial volume
3. Set volume to 0
4. Wait 2 seconds
5. Set volume to 50
6. Wait 2 seconds
7. Mute the speaker
8. Wait 2 seconds
9. Unmute the speaker

This helps verify that:

- Your speaker is reachable on the network
- Volume control is working
- Mute control is working

If you see any errors, check that:

- Your speaker's IP address is correct
- Your speaker is powered on and connected to the network
- Your computer is on the same network as the speaker

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built using the [Elgato Stream Deck SDK](https://developer.elgato.com/documentation/stream-deck/)
- Uses [sonos](https://github.com/bencevans/node-sonos) for Sonos control
- Icons adapted from SF Symbols
- Written entirely using [Cursor](https://cursor.sh/) and Claude-3.5-Sonnet
