import { useRef, useState, useCallback, useEffect } from 'react';
import { Device, types as msTypes } from 'mediasoup-client';

/**
 * Custom hook that manages the entire mediasoup-client lifecycle:
 * - Device initialization with router capabilities
 * - Send/recv transport creation and wiring
 * - getUserMedia and producing audio/video
 * - Consuming remote tracks based on proximity
 * - Mute/camera toggles
 */

export interface RemoteStream {
    peerId: string;
    stream: MediaStream;
    kind: 'audio' | 'video';
}

export interface UseMediasoupReturn {
    // State
    nearbyPeers: string[];
    remoteStreams: Map<string, MediaStream>;
    localStream: MediaStream | null;
    inCall: boolean;
    audioMuted: boolean;
    videoOff: boolean;
    mediaReady: boolean;

    // Controls
    toggleAudio: () => void;
    toggleVideo: () => void;

    // WS message handlers (called from Game.page.tsx)
    handleRouterRtpCapabilities: (payload: any) => void;
    handleTransportCreated: (payload: any) => void;
    handleTransportConnected: (payload: any) => void;
    handleProduced: (payload: any) => void;
    handleNewConsumer: (payload: any) => void;
    handleConsumerClosed: (payload: any) => void;
    handleProximityUpdate: (nearby: string[]) => void;

    // Initialization
    initMedia: (ws: WebSocket) => void;
    cleanup: () => void;
}

export function useMediasoup(): UseMediasoupReturn {
    const deviceRef = useRef<Device | null>(null);
    const sendTransportRef = useRef<msTypes.Transport | null>(null);
    const recvTransportRef = useRef<msTypes.Transport | null>(null);
    const localStreamRef = useRef<MediaStream | null>(null);
    const wsRef = useRef<WebSocket | null>(null);

    // Pending callbacks for request-reply WS messages
    const pendingConnectResolversRef = useRef<Map<string, () => void>>(new Map());
    const pendingProduceResolversRef = useRef<Map<string, (id: string) => void>>(new Map());

    // Tracking state
    const producersRef = useRef<Map<string, msTypes.Producer>>(new Map()); // kind -> Producer
    const consumersRef = useRef<Map<string, msTypes.Consumer>>(new Map()); // consumerId -> Consumer

    const [nearbyPeers, setNearbyPeers] = useState<string[]>([]);
    const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [audioMuted, setAudioMuted] = useState(false);
    const [videoOff, setVideoOff] = useState(false);
    const [mediaReady, setMediaReady] = useState(false);

    const inCall = nearbyPeers.length > 0;

    // ─── Send a WS message ─────────────────────────────────────────────

    const wsSend = useCallback((type: string, payload: any = {}) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type, payload }));
        }
    }, []);

    // ─── Init: start the media pipeline ────────────────────────────────

    const initMedia = useCallback((ws: WebSocket) => {
        wsRef.current = ws;

        // Step 1: request router capabilities
        wsSend('get-router-rtp-capabilities');
    }, [wsSend]);

    // ─── Handle router-rtp-capabilities ────────────────────────────────

    const handleRouterRtpCapabilities = useCallback(async (payload: any) => {
        const { rtpCapabilities } = payload;
        if (!rtpCapabilities) {
            console.error('[useMediasoup] No rtpCapabilities in payload');
            return;
        }

        try {
            // Create and load Device
            const device = new Device();
            await device.load({ routerRtpCapabilities: rtpCapabilities });
            deviceRef.current = device;

            // Send our capabilities back to the server
            wsSend('set-rtp-capabilities', {
                rtpCapabilities: device.rtpCapabilities,
            });

            // Request send transport
            wsSend('create-transport', { direction: 'send' });
            // Request recv transport
            wsSend('create-transport', { direction: 'recv' });
        } catch (err) {
            console.error('[useMediasoup] Failed to load device:', err);
        }
    }, [wsSend]);

    // ─── Handle transport-created ──────────────────────────────────────

    const handleTransportCreated = useCallback((payload: any) => {
        const device = deviceRef.current;
        if (!device) return;

        const { direction, id, iceParameters, iceCandidates, dtlsParameters } = payload;

        if (direction === 'send') {
            const transport = device.createSendTransport({
                id,
                iceParameters,
                iceCandidates,
                dtlsParameters,
            });

            transport.on('connect', ({ dtlsParameters: dtls }, callback, errback) => {
                try {
                    pendingConnectResolversRef.current.set(id, callback);
                    wsSend('connect-transport', { transportId: id, dtlsParameters: dtls });
                } catch (err: any) {
                    errback(err);
                }
            });

            transport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
                try {
                    const resolveKey = `${id}:${kind}`;
                    pendingProduceResolversRef.current.set(resolveKey, (producerId: string) => {
                        callback({ id: producerId });
                    });
                    wsSend('produce', { transportId: id, kind, rtpParameters });
                } catch (err: any) {
                    errback(err);
                }
            });

            sendTransportRef.current = transport;
        } else if (direction === 'recv') {
            const transport = device.createRecvTransport({
                id,
                iceParameters,
                iceCandidates,
                dtlsParameters,
            });

            transport.on('connect', ({ dtlsParameters: dtls }, callback, errback) => {
                try {
                    pendingConnectResolversRef.current.set(id, callback);
                    wsSend('connect-transport', { transportId: id, dtlsParameters: dtls });
                } catch (err: any) {
                    errback(err);
                }
            });

            recvTransportRef.current = transport;
        }

        // Once both transports are created, start producing
        if (sendTransportRef.current && recvTransportRef.current) {
            startProducing();
        }
    }, [wsSend]);

    // ─── Start producing audio/video ───────────────────────────────────

    const startProducing = useCallback(async () => {
        const sendTransport = sendTransportRef.current;
        if (!sendTransport) return;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: {
                    width: { ideal: 320 },
                    height: { ideal: 240 },
                    frameRate: { ideal: 15 },
                },
            });

            localStreamRef.current = stream;
            setLocalStream(stream);

            // Produce audio track
            const audioTrack = stream.getAudioTracks()[0];
            if (audioTrack) {
                const audioProducer = await sendTransport.produce({
                    track: audioTrack,
                    codecOptions: { opusStereo: true, opusDtx: true },
                });
                producersRef.current.set('audio', audioProducer);
            }

            // Produce video track
            const videoTrack = stream.getVideoTracks()[0];
            if (videoTrack) {
                const videoProducer = await sendTransport.produce({
                    track: videoTrack,
                    codecOptions: { videoGoogleStartBitrate: 1000 },
                });
                producersRef.current.set('video', videoProducer);
            }

            setMediaReady(true);
            console.log('[useMediasoup] Producing audio and video');
        } catch (err) {
            console.error('[useMediasoup] Failed to produce media:', err);
            // Try audio-only if video fails
            try {
                const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                localStreamRef.current = audioStream;
                setLocalStream(audioStream);

                const audioTrack = audioStream.getAudioTracks()[0];
                if (audioTrack && sendTransport) {
                    const audioProducer = await sendTransport.produce({ track: audioTrack });
                    producersRef.current.set('audio', audioProducer);
                }
                setMediaReady(true);
                console.log('[useMediasoup] Producing audio only (video failed)');
            } catch (audioErr) {
                console.error('[useMediasoup] Failed to produce audio:', audioErr);
            }
        }
    }, []);

    // ─── Handle transport-connected ────────────────────────────────────

    const handleTransportConnected = useCallback((payload: any) => {
        const { transportId } = payload;
        const resolver = pendingConnectResolversRef.current.get(transportId);
        if (resolver) {
            resolver();
            pendingConnectResolversRef.current.delete(transportId);
        }
    }, []);

    // ─── Handle produced ───────────────────────────────────────────────

    const handleProduced = useCallback((payload: any) => {
        const { id, kind } = payload;
        const sendTransport = sendTransportRef.current;
        if (!sendTransport) return;

        const resolveKey = `${sendTransport.id}:${kind}`;
        const resolver = pendingProduceResolversRef.current.get(resolveKey);
        if (resolver) {
            resolver(id);
            pendingProduceResolversRef.current.delete(resolveKey);
        }
    }, []);

    // ─── Handle new-consumer ───────────────────────────────────────────

    const handleNewConsumer = useCallback(async (payload: any) => {
        const recvTransport = recvTransportRef.current;
        if (!recvTransport) {
            console.error('[useMediasoup] No recv transport for consumer');
            return;
        }

        const { peerId, id, producerId, kind, rtpParameters } = payload;

        try {
            const consumer = await recvTransport.consume({
                id,
                producerId,
                kind,
                rtpParameters,
            });

            consumersRef.current.set(id, consumer);

            // Add/update the remote stream for this peer
            setRemoteStreams((prev) => {
                const next = new Map(prev);
                const existing = next.get(peerId) || new MediaStream();

                // Remove existing tracks of same kind
                existing.getTracks().forEach(t => {
                    if (t.kind === kind) {
                        existing.removeTrack(t);
                    }
                });

                existing.addTrack(consumer.track);
                next.set(peerId, existing);
                return next;
            });

            // Resume the consumer on the server
            wsSend('resume-consumer', { consumerId: id });

            console.log(`[useMediasoup] Consuming ${kind} from ${peerId}`);
        } catch (err) {
            console.error('[useMediasoup] Failed to consume:', err);
        }
    }, [wsSend]);

    // ─── Handle consumer-closed ────────────────────────────────────────

    const handleConsumerClosed = useCallback((payload: any) => {
        const { peerId } = payload;

        // Remove all consumers for this peer
        for (const [consumerId, consumer] of consumersRef.current) {
            // We find consumers for this peer by checking if they match
            // Since we don't track peerId on consumer, we close all and let setRemoteStreams handle it
        }

        setRemoteStreams((prev) => {
            const next = new Map(prev);
            const stream = next.get(peerId);
            if (stream) {
                stream.getTracks().forEach(t => t.stop());
                next.delete(peerId);
            }
            return next;
        });

        console.log(`[useMediasoup] Consumer closed for peer: ${peerId}`);
    }, []);

    // ─── Handle PROXIMITY_UPDATE ───────────────────────────────────────

    const handleProximityUpdate = useCallback((nearby: string[]) => {
        setNearbyPeers(nearby);
    }, []);

    // ─── Audio/Video toggles ───────────────────────────────────────────

    const toggleAudio = useCallback(() => {
        const audioProducer = producersRef.current.get('audio');
        if (!audioProducer) return;

        const track = audioProducer.track;
        if (track) {
            track.enabled = !track.enabled;
            setAudioMuted(!track.enabled);
        }
    }, []);

    const toggleVideo = useCallback(() => {
        const videoProducer = producersRef.current.get('video');
        if (!videoProducer) return;

        const track = videoProducer.track;
        if (track) {
            track.enabled = !track.enabled;
            setVideoOff(!track.enabled);
        }
    }, []);

    // ─── Cleanup ───────────────────────────────────────────────────────

    const cleanup = useCallback(() => {
        // Close consumers
        for (const consumer of consumersRef.current.values()) {
            consumer.close();
        }
        consumersRef.current.clear();

        // Close producers
        for (const producer of producersRef.current.values()) {
            producer.close();
        }
        producersRef.current.clear();

        // Close transports
        if (sendTransportRef.current) {
            sendTransportRef.current.close();
            sendTransportRef.current = null;
        }
        if (recvTransportRef.current) {
            recvTransportRef.current.close();
            recvTransportRef.current = null;
        }

        // Stop local tracks
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(t => t.stop());
            localStreamRef.current = null;
        }

        // Clear remote streams
        setRemoteStreams(prev => {
            prev.forEach(stream => stream.getTracks().forEach(t => t.stop()));
            return new Map();
        });

        deviceRef.current = null;
        setLocalStream(null);
        setNearbyPeers([]);
        setMediaReady(false);
        setAudioMuted(false);
        setVideoOff(false);

        pendingConnectResolversRef.current.clear();
        pendingProduceResolversRef.current.clear();
    }, []);

    return {
        nearbyPeers,
        remoteStreams,
        localStream,
        inCall,
        audioMuted,
        videoOff,
        mediaReady,

        toggleAudio,
        toggleVideo,

        handleRouterRtpCapabilities,
        handleTransportCreated,
        handleTransportConnected,
        handleProduced,
        handleNewConsumer,
        handleConsumerClosed,
        handleProximityUpdate,

        initMedia,
        cleanup,
    };
}
