/**
 * BubbleGun2 Web Worker
 * Finds bubbles and their nesting in a background thread
 */

import createBubbleGunModule from './bubblegun.js';

const modulePromise = createBubbleGunModule();

// Handle messages from main thread
self.onmessage = async function(e) {
    const { type, id, data } = e.data;
    if (type !== 'find-bubbles') {
        console.error('Unknown message type:', type);
        return;
    }

    try {
        const module = await modulePromise;

        const startTime = performance.now();
        const result = module.findBubbles(data.nodeLengths, data.edges);
        const duration = performance.now() - startTime;

        if (result.error) {
            throw new Error(result.error);
        }

        // The typed arrays are handed over rather than copied.
        self.postMessage(
            { type: 'bubbles-result', id, success: true, result, duration },
            [result.source, result.sink, result.type, result.parent, result.insideOffsets, result.inside]
                .map(array => array.buffer),
        );
    } catch (error) {
        self.postMessage({
            type: 'bubbles-result',
            id,
            success: false,
            error: error.message
        });
    }
};
