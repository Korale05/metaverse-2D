import * as mediasoup from "mediasoup";
import { types as mediasoupTypes } from "mediasoup";
import os from "os";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Peer {
    userId: string;
    spaceId: string;
    sendTransport: mediasoupTypes.WebRtcTransport | null;
    recvTransport: mediasoupTypes.WebRtcTransport | null;
    producers: Map<string, mediasoupTypes.Producer>; // kind -> Producer
    consumersByPeer: Map<string, mediasoupTypes.Consumer[]>; // peerId -> Consumer[]
    rtpCapabilities: mediasoupTypes.RtpCapabilities | null;
}

export interface TransportInfo {
    id: string;
    iceParameters: mediasoupTypes.IceParameters;
    iceCandidates: mediasoupTypes.IceCandidate[];
    dtlsParameters: mediasoupTypes.DtlsParameters;
}

// ─── Codec capabilities for the Router ───────────────────────────────────────

const mediaCodecs: mediasoupTypes.RtpCodecCapability[] = [
    {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
    },
    {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
        parameters: {
            "x-google-start-bitrate": 1000,
        },
    },
];

// ─── MediaManager Singleton ──────────────────────────────────────────────────

export class MediaManager {
    private static instance: MediaManager;

    private workers: mediasoupTypes.Worker[] = [];
    private nextWorkerIdx = 0;
    private routers: Map<string, mediasoupTypes.Router> = new Map(); // spaceId -> Router
    private peers: Map<string, Peer> = new Map(); // userId -> Peer
    private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map(); // "userId:peerId" -> timer

    // Callback to send messages to a user via their WS connection.
    // Set externally by User.ts when the peer is created.
    private sendCallbacks: Map<string, (msg: any) => void> = new Map(); // userId -> send fn

    private constructor() {}

    static getInstance(): MediaManager {
        if (!this.instance) {
            this.instance = new MediaManager();
        }
        return this.instance;
    }

    // ─── Initialization ────────────────────────────────────────────────────

    async init(): Promise<void> {
        const numWorkers = os.cpus().length;
        const rtcMinPort = parseInt(process.env.RTC_MIN_PORT || "40000", 10);
        const rtcMaxPort = parseInt(process.env.RTC_MAX_PORT || "40100", 10);

        console.log(`[MediaManager] Creating ${numWorkers} mediasoup Workers (ports ${rtcMinPort}-${rtcMaxPort})`);

        for (let i = 0; i < numWorkers; i++) {
            const worker = await mediasoup.createWorker({
                logLevel: "warn",
                rtcMinPort,
                rtcMaxPort,
            });

            worker.on("died", () => {
                console.error(`[MediaManager] Worker ${i} died! Exiting in 2 seconds...`);
                setTimeout(() => process.exit(1), 2000);
            });

            this.workers.push(worker);
        }

        console.log(`[MediaManager] ${this.workers.length} Workers created successfully`);
    }

    // ─── Worker round-robin ────────────────────────────────────────────────

    private getNextWorker(): mediasoupTypes.Worker {
        const worker = this.workers[this.nextWorkerIdx]!;
        this.nextWorkerIdx = (this.nextWorkerIdx + 1) % this.workers.length;
        return worker;
    }

    // ─── Router management ─────────────────────────────────────────────────

    async getOrCreateRouter(spaceId: string): Promise<mediasoupTypes.Router> {
        let router = this.routers.get(spaceId);
        if (router) return router;

        const worker = this.getNextWorker();
        router = await worker.createRouter({ mediaCodecs });
        this.routers.set(spaceId, router);
        console.log(`[MediaManager] Router created for space: ${spaceId}`);
        return router;
    }

    private cleanupRouter(spaceId: string): void {
        const router = this.routers.get(spaceId);
        if (!router) return;

        // Check if any peers still in this space
        for (const peer of this.peers.values()) {
            if (peer.spaceId === spaceId) return; // still has peers, don't close
        }

        router.close();
        this.routers.delete(spaceId);
        console.log(`[MediaManager] Router closed for space: ${spaceId}`);
    }

    getRouterRtpCapabilities(spaceId: string): mediasoupTypes.RtpCapabilities | null {
        const router = this.routers.get(spaceId);
        return router ? router.rtpCapabilities : null;
    }

    // ─── Peer management ───────────────────────────────────────────────────

    async createPeer(userId: string, spaceId: string, sendFn: (msg: any) => void): Promise<void> {
        // Ensure router exists
        await this.getOrCreateRouter(spaceId);

        const peer: Peer = {
            userId,
            spaceId,
            sendTransport: null,
            recvTransport: null,
            producers: new Map(),
            consumersByPeer: new Map(),
            rtpCapabilities: null,
        };

        this.peers.set(userId, peer);
        this.sendCallbacks.set(userId, sendFn);
        console.log(`[MediaManager] Peer created: ${userId} in space: ${spaceId}`);
    }

    removePeer(userId: string): void {
        const peer = this.peers.get(userId);
        if (!peer) return;

        const spaceId = peer.spaceId;

        // Close all consumers
        for (const [peerId, consumers] of peer.consumersByPeer) {
            for (const consumer of consumers) {
                consumer.close();
            }
            // Cancel any debounce timers
            const timerKey = `${userId}:${peerId}`;
            const timer = this.debounceTimers.get(timerKey);
            if (timer) {
                clearTimeout(timer);
                this.debounceTimers.delete(timerKey);
            }
        }

        // Close all producers
        for (const producer of peer.producers.values()) {
            producer.close();
        }

        // Close transports
        if (peer.sendTransport) peer.sendTransport.close();
        if (peer.recvTransport) peer.recvTransport.close();

        // Remove consumers that OTHER peers have for this user
        for (const [otherUserId, otherPeer] of this.peers) {
            if (otherUserId === userId) continue;
            const consumers = otherPeer.consumersByPeer.get(userId);
            if (consumers) {
                for (const consumer of consumers) {
                    consumer.close();
                }
                otherPeer.consumersByPeer.delete(userId);

                // Notify the other peer
                const sendFn = this.sendCallbacks.get(otherUserId);
                if (sendFn) {
                    sendFn({
                        type: "consumer-closed",
                        payload: { peerId: userId },
                    });
                }
            }

            // Cancel debounce timers referencing this user
            const timerKey = `${otherUserId}:${userId}`;
            const timer = this.debounceTimers.get(timerKey);
            if (timer) {
                clearTimeout(timer);
                this.debounceTimers.delete(timerKey);
            }
        }

        this.peers.delete(userId);
        this.sendCallbacks.delete(userId);

        console.log(`[MediaManager] Peer removed: ${userId}`);

        // Clean up router if space is now empty
        this.cleanupRouter(spaceId);
    }

    // ─── Transport creation ────────────────────────────────────────────────

    async createWebRtcTransport(userId: string, direction: "send" | "recv"): Promise<TransportInfo> {
        const peer = this.peers.get(userId);
        if (!peer) throw new Error(`Peer not found: ${userId}`);

        const router = this.routers.get(peer.spaceId);
        if (!router) throw new Error(`Router not found for space: ${peer.spaceId}`);

        const listenIp = process.env.MEDIASOUP_LISTEN_IP || "0.0.0.0";
        const announcedIp = process.env.MEDIASOUP_ANNOUNCED_IP || "127.0.0.1";

        const transport = await router.createWebRtcTransport({
            listenInfos: [
                {
                    protocol: "udp" as const,
                    ip: listenIp,
                    announcedAddress: announcedIp,
                },
                {
                    protocol: "tcp" as const,
                    ip: listenIp,
                    announcedAddress: announcedIp,
                },
            ],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
        });

        transport.on("dtlsstatechange", (dtlsState) => {
            if (dtlsState === "closed") {
                console.log(`[MediaManager] Transport ${transport.id} closed for ${userId}`);
                transport.close();
            }
        });

        if (direction === "send") {
            peer.sendTransport = transport;
        } else {
            peer.recvTransport = transport;
        }

        return {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
        };
    }

    // ─── Transport connect ─────────────────────────────────────────────────

    async connectTransport(
        userId: string,
        transportId: string,
        dtlsParameters: mediasoupTypes.DtlsParameters
    ): Promise<void> {
        const peer = this.peers.get(userId);
        if (!peer) throw new Error(`Peer not found: ${userId}`);

        const transport =
            peer.sendTransport?.id === transportId
                ? peer.sendTransport
                : peer.recvTransport?.id === transportId
                    ? peer.recvTransport
                    : null;

        if (!transport) throw new Error(`Transport not found: ${transportId}`);

        await transport.connect({ dtlsParameters });
    }

    // ─── Produce ───────────────────────────────────────────────────────────

    async produce(
        userId: string,
        transportId: string,
        kind: mediasoupTypes.MediaKind,
        rtpParameters: mediasoupTypes.RtpParameters
    ): Promise<string> {
        const peer = this.peers.get(userId);
        if (!peer) throw new Error(`Peer not found: ${userId}`);

        if (!peer.sendTransport || peer.sendTransport.id !== transportId) {
            throw new Error(`Send transport mismatch for ${userId}`);
        }

        const producer = await peer.sendTransport.produce({ kind, rtpParameters });

        producer.on("transportclose", () => {
            peer.producers.delete(kind);
        });

        peer.producers.set(kind, producer);
        console.log(`[MediaManager] Producer created: ${userId} kind=${kind} id=${producer.id}`);

        // Push this new producer to all peers who are already nearby
        this.syncNewProducer(userId);

        return producer.id;
    }

    // ─── Resume Consumer ───────────────────────────────────────────────────

    async resumeConsumer(userId: string, consumerId: string): Promise<void> {
        const peer = this.peers.get(userId);
        if (!peer) throw new Error(`Peer not found: ${userId}`);

        for (const consumers of peer.consumersByPeer.values()) {
            for (const consumer of consumers) {
                if (consumer.id === consumerId) {
                    await consumer.resume();
                    return;
                }
            }
        }

        throw new Error(`Consumer not found: ${consumerId}`);
    }

    // ─── Core: syncConsumers (proximity → media bridge) ────────────────────

    /**
     * Called whenever a user's nearby set changes.
     * Creates consumers for new nearby peers, removes consumers for departed peers (with debounce).
     */
    syncConsumers(userId: string, nearbyUserIds: string[]): void {
        const peer = this.peers.get(userId);
        if (!peer) return;
        if (!peer.recvTransport) return; // Can't consume without a recv transport

        const nearbySet = new Set(nearbyUserIds);

        // 1. Peers that are no longer nearby → debounce-close their consumers
        for (const [consumedPeerId] of peer.consumersByPeer) {
            if (!nearbySet.has(consumedPeerId)) {
                const timerKey = `${userId}:${consumedPeerId}`;
                if (!this.debounceTimers.has(timerKey)) {
                    this.debounceTimers.set(
                        timerKey,
                        setTimeout(() => {
                            this.debounceTimers.delete(timerKey);
                            this.closeConsumersForPeer(userId, consumedPeerId);
                        }, 300) // 300ms debounce
                    );
                }
            }
        }

        // 2. Peers newly in the nearby set → create consumers for their producers
        for (const nearbyUserId of nearbyUserIds) {
            // Cancel any pending removal debounce
            const timerKey = `${userId}:${nearbyUserId}`;
            const timer = this.debounceTimers.get(timerKey);
            if (timer) {
                clearTimeout(timer);
                this.debounceTimers.delete(timerKey);
            }

            // If we already have consumers for this peer, skip
            if (peer.consumersByPeer.has(nearbyUserId)) continue;

            // Create consumers for each of the nearby peer's producers
            const nearbyPeer = this.peers.get(nearbyUserId);
            if (!nearbyPeer) continue;

            for (const [kind, producer] of nearbyPeer.producers) {
                this.createConsumerForPeer(userId, nearbyUserId, producer).catch((err) => {
                    console.error(`[MediaManager] Failed to create consumer: ${userId} <- ${nearbyUserId} (${kind}):`, err);
                });
            }
        }
    }

    /**
     * When a new producer is created, push it to all peers that are currently nearby.
     * This is called from produce() so that existing nearby peers immediately receive the new track.
     */
    private syncNewProducer(producerUserId: string): void {
        const producerPeer = this.peers.get(producerUserId);
        if (!producerPeer) return;

        // Find all peers who currently have consumers from this producer's user
        // OR who are in the same space. We rely on consumersByPeer as proxy for "currently nearby".
        // Actually, we need to check all peers in the same space who already consume from us.
        for (const [otherUserId, otherPeer] of this.peers) {
            if (otherUserId === producerUserId) continue;
            if (otherPeer.spaceId !== producerPeer.spaceId) continue;
            if (!otherPeer.recvTransport) continue;

            // Only push to peers who already have consumers from us (meaning they're nearby)
            if (!otherPeer.consumersByPeer.has(producerUserId)) continue;

            // Check each producer — only create consumers for producers not yet consumed
            for (const [kind, producer] of producerPeer.producers) {
                const existingConsumers = otherPeer.consumersByPeer.get(producerUserId) || [];
                const alreadyConsuming = existingConsumers.some(
                    (c) => c.producerId === producer.id
                );
                if (!alreadyConsuming) {
                    this.createConsumerForPeer(otherUserId, producerUserId, producer).catch((err) => {
                        console.error(`[MediaManager] Failed to sync new producer to ${otherUserId}:`, err);
                    });
                }
            }
        }
    }

    // ─── Internal: create a single consumer ────────────────────────────────

    private async createConsumerForPeer(
        consumerUserId: string,
        producerUserId: string,
        producer: mediasoupTypes.Producer
    ): Promise<void> {
        const consumerPeer = this.peers.get(consumerUserId);
        if (!consumerPeer || !consumerPeer.recvTransport || !consumerPeer.rtpCapabilities) return;

        const router = this.routers.get(consumerPeer.spaceId);
        if (!router) return;

        // Check if the consumer's device can consume this producer
        if (
            !router.canConsume({
                producerId: producer.id,
                rtpCapabilities: consumerPeer.rtpCapabilities,
            })
        ) {
            console.warn(`[MediaManager] Cannot consume: ${consumerUserId} <- producer ${producer.id}`);
            return;
        }

        const consumer = await consumerPeer.recvTransport.consume({
            producerId: producer.id,
            rtpCapabilities: consumerPeer.rtpCapabilities,
            paused: true, // Start paused; client calls resume after attaching
        });

        consumer.on("transportclose", () => {
            // Remove from consumersByPeer
            const consumers = consumerPeer.consumersByPeer.get(producerUserId);
            if (consumers) {
                const filtered = consumers.filter((c) => c.id !== consumer.id);
                if (filtered.length === 0) {
                    consumerPeer.consumersByPeer.delete(producerUserId);
                } else {
                    consumerPeer.consumersByPeer.set(producerUserId, filtered);
                }
            }
        });

        consumer.on("producerclose", () => {
            consumer.close();
            const consumers = consumerPeer.consumersByPeer.get(producerUserId);
            if (consumers) {
                const filtered = consumers.filter((c) => c.id !== consumer.id);
                if (filtered.length === 0) {
                    consumerPeer.consumersByPeer.delete(producerUserId);
                } else {
                    consumerPeer.consumersByPeer.set(producerUserId, filtered);
                }
            }

            // Notify client
            const sendFn = this.sendCallbacks.get(consumerUserId);
            if (sendFn) {
                sendFn({
                    type: "producer-closed",
                    payload: {
                        peerId: producerUserId,
                        consumerId: consumer.id,
                    },
                });
            }
        });

        // Store
        if (!consumerPeer.consumersByPeer.has(producerUserId)) {
            consumerPeer.consumersByPeer.set(producerUserId, []);
        }
        consumerPeer.consumersByPeer.get(producerUserId)!.push(consumer);

        // Notify client about the new consumer
        const sendFn = this.sendCallbacks.get(consumerUserId);
        if (sendFn) {
            sendFn({
                type: "new-consumer",
                payload: {
                    peerId: producerUserId,
                    id: consumer.id,
                    producerId: producer.id,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                },
            });
        }

        console.log(`[MediaManager] Consumer created: ${consumerUserId} <- ${producerUserId} (${consumer.kind})`);
    }

    // ─── Internal: close consumers for a specific peer ─────────────────────

    private closeConsumersForPeer(userId: string, peerId: string): void {
        const peer = this.peers.get(userId);
        if (!peer) return;

        const consumers = peer.consumersByPeer.get(peerId);
        if (consumers) {
            for (const consumer of consumers) {
                consumer.close();
            }
            peer.consumersByPeer.delete(peerId);

            const sendFn = this.sendCallbacks.get(userId);
            if (sendFn) {
                sendFn({
                    type: "consumer-closed",
                    payload: { peerId },
                });
            }

            console.log(`[MediaManager] Consumers closed: ${userId} <- ${peerId}`);
        }
    }

    // ─── Store RTP capabilities from the client's Device ───────────────────

    setRtpCapabilities(userId: string, rtpCapabilities: mediasoupTypes.RtpCapabilities): void {
        const peer = this.peers.get(userId);
        if (peer) {
            peer.rtpCapabilities = rtpCapabilities;
        }
    }

    // ─── Utility: check if peer exists ─────────────────────────────────────

    hasPeer(userId: string): boolean {
        return this.peers.has(userId);
    }

    getPeer(userId: string): Peer | undefined {
        return this.peers.get(userId);
    }
}
