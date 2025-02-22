const { Sonos } = require('sonos');

async function testSonosConnection() {
    // Change this to your Sonos speaker's IP address
    const speakerIp = '192.168.1.xxx';
    console.log(`Testing connection to Sonos speaker at ${speakerIp}...`);

    try {
        const sonos = new Sonos(speakerIp);
        
        // Get initial volume
        const initialVolume = await sonos.getVolume();
        console.log(`Initial volume: ${initialVolume}`);

        // Set volume to 0
        console.log('Setting volume to 0...');
        await sonos.setVolume(0);
        console.log('Volume set to 0');

        // Wait for 2 seconds
        console.log('Waiting for 2 seconds...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Set volume to 50
        console.log('Setting volume to 50...');
        await sonos.setVolume(50);
        console.log('Volume set to 50');

        // Get final volume to verify
        const finalVolume = await sonos.getVolume();
        console.log(`Final volume: ${finalVolume}`);

        // Wait for 2 seconds before starting mute tests
        console.log('Waiting for 2 seconds...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Test mute/unmute
        console.log('\nTesting mute/unmute...');
        
        // Mute the speaker
        console.log('Muting speaker...');
        await sonos.setMuted(true);
        const isMuted = await sonos.getMuted();
        console.log(`Mute state: ${isMuted}`);

        // Wait for 2 seconds
        console.log('Waiting for 2 seconds...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Unmute the speaker
        console.log('Unmuting speaker...');
        await sonos.setMuted(false);
        const isUnmuted = await sonos.getMuted();
        console.log(`Mute state: ${isUnmuted}`);

    } catch (error) {
        console.error('Failed to connect to speaker:', error);
    }
}

// Run the test
testSonosConnection().catch(console.error);