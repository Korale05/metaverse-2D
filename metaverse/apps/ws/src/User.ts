
import WebSocket from "ws";
import { Message } from "./types.js";
import { RoomManager } from "./RoomManager.js";
import { MediaManager } from "./mediaManager.js";
import prisma from "@repo/db";
import jwt, { JwtPayload } from "jsonwebtoken";

function randomString() {
    return Math.random().toString(36).substring(2, 10);
}

export class User {
    public id: string;
    private spaceId?: string;
    public x: number;
    public y: number;
    public userId: (string | null);

    constructor(private ws: WebSocket) {
        this.id = randomString();
        this.x = 0;
        this.y = 0;
        this.userId = null;
    }

    initHandlers() {
        this.ws.on("message", async (data) => {
            let parsedData: any;
            try {
                parsedData = JSON.parse(data.toString());
            } catch (e) {
                return;
            }

            switch (parsedData.type) {
                case "join": {
                    const spaceId = parsedData.payload?.spaceId;
                    const accessToekn = parsedData.payload?.token;
                    if (!spaceId || !accessToekn) {
                        return this.ws.close();
                    }

                    const JWT_PASSWORD = process.env.JWT_PASSWORD;
                    if (!JWT_PASSWORD) {
                        console.error("JWT_PASSWORD env var is not set");
                        return this.ws.close();
                    }
                    let userID: string | undefined;
                    try {
                        const decoded = jwt.verify(accessToekn, JWT_PASSWORD) as JwtPayload;
                        userID = decoded.userId || decoded.id;
                    } catch (e) {
                        return this.ws.close();
                    }

                    if (!userID) {
                        return this.ws.close();
                    }
                    this.userId = userID;

                    const space = await prisma.space.findFirst({
                        where: {
                            id: spaceId
                        }
                    });
                    if (!space) {
                        return this.ws.close();
                    }

                    RoomManager.getInstance().addUser(spaceId, this);
                    this.spaceId = spaceId;
                    this.x = Math.floor(Math.random() * space.width);
                    this.y = Math.floor(Math.random() * space.height);

                    const existingUsers = (RoomManager.getInstance().rooms.get(spaceId) ?? [])
                        .filter((u) => u.id !== this.id)
                        .map((e) => ({ 
                            id: e.userId ?? e.id,
                            userId: e.userId ?? e.id,
                            x: e.x,
                            y: e.y 
                        }));


                    // This message goes to you indicating that you joined the room 
                    this.send({
                        type: "space-joined",
                        payload: {
                            spawn: {
                                x: this.x,
                                y: this.y
                            },
                            users: existingUsers
                        }
                    });

                    // THis tell all other users are present in the room that you are joind the room 
                    RoomManager.getInstance().broadcast({
                        type: "user-join",
                        payload: {
                            userId: this.userId,
                            x: this.x,
                            y: this.y
                        }
                    }, this, spaceId);

                    // Compute proximity groups after joining
                    RoomManager.getInstance().updateProximity(spaceId);

                    // Create a media peer for this user
                    try {
                        await MediaManager.getInstance().createPeer(
                            this.userId,
                            spaceId,
                            (msg: any) => this.send(msg)
                        );
                    } catch (err) {
                        console.error("Failed to create media peer:", err);
                    }
                    break;
                }
                case "move": {
                    
                    if (!this.spaceId) {
                        return;
                    }
                    const moveX = parsedData.payload?.x;
                    const moveY = parsedData.payload?.y;
                    if (typeof moveX !== "number" || typeof moveY !== "number") {
                        return;
                    }

                    const xDisplacement = Math.abs(this.x - moveX);
                    const yDisplacement = Math.abs(this.y - moveY);

                    if ((xDisplacement === 1 && yDisplacement === 0) || (xDisplacement === 0 && yDisplacement === 1)) {
                        // Collision Check
                        const users = RoomManager.getInstance().rooms.get(this.spaceId) ?? [];
                        const isOccupied = users.some(
                            (u) => u !== this && u.x === moveX && u.y === moveY
                        );

                        if(isOccupied){
                            console.log("Move Rejected!");
                            this.send({
                                type: "movement-rejected",
                                payload: {
                                    x: this.x,
                                    y: this.y
                                }
                            });
                            return;
                        }
                        // update the position 
                        this.x = moveX;
                        this.y = moveY;
                        //brodcast the position 
                        RoomManager.getInstance().broadcast({
                            type: "move",
                            payload: {
                                x: this.x,
                                y: this.y,
                                userId: this.userId
                            }
                        }, this, this.spaceId);

                        // Recompute proximity groups for the entire space after movement
                        RoomManager.getInstance().updateProximity(this.spaceId);
                        return;
                    }

                    this.send({
                        type: "movement-rejected",
                        payload: {
                            x: this.x,
                            y: this.y
                        }
                    });
                    break;
                }

                // ── Media signaling messages ──────────────────────────────

                case "get-router-rtp-capabilities": {
                    if (!this.spaceId || !this.userId) return;
                    try {
                        const caps = MediaManager.getInstance().getRouterRtpCapabilities(this.spaceId);
                        this.send({
                            type: "router-rtp-capabilities",
                            payload: { rtpCapabilities: caps }
                        });
                    } catch (err) {
                        console.error("Failed to get router capabilities:", err);
                    }
                    break;
                }

                case "set-rtp-capabilities": {
                    if (!this.userId) return;
                    const rtpCaps = parsedData.payload?.rtpCapabilities;
                    if (rtpCaps) {
                        MediaManager.getInstance().setRtpCapabilities(this.userId, rtpCaps);
                    }
                    break;
                }

                case "create-transport": {
                    if (!this.userId) return;
                    const direction = parsedData.payload?.direction;
                    if (direction !== "send" && direction !== "recv") return;
                    try {
                        const transportInfo = await MediaManager.getInstance().createWebRtcTransport(
                            this.userId,
                            direction
                        );
                        this.send({
                            type: "transport-created",
                            payload: {
                                direction,
                                ...transportInfo
                            }
                        });
                    } catch (err) {
                        console.error("Failed to create transport:", err);
                        this.send({ type: "error", payload: { message: "Failed to create transport" } });
                    }
                    break;
                }

                case "connect-transport": {
                    if (!this.userId) return;
                    const { transportId, dtlsParameters } = parsedData.payload ?? {};
                    if (!transportId || !dtlsParameters) return;
                    try {
                        await MediaManager.getInstance().connectTransport(
                            this.userId,
                            transportId,
                            dtlsParameters
                        );
                        this.send({ type: "transport-connected", payload: { transportId } });
                    } catch (err) {
                        console.error("Failed to connect transport:", err);
                        this.send({ type: "error", payload: { message: "Failed to connect transport" } });
                    }
                    break;
                }

                case "produce": {
                    if (!this.userId) return;
                    const { transportId: prodTransportId, kind, rtpParameters } = parsedData.payload ?? {};
                    if (!prodTransportId || !kind || !rtpParameters) return;
                    try {
                        const producerId = await MediaManager.getInstance().produce(
                            this.userId,
                            prodTransportId,
                            kind,
                            rtpParameters
                        );
                        this.send({
                            type: "produced",
                            payload: { id: producerId, kind }
                        });
                    } catch (err) {
                        console.error("Failed to produce:", err);
                        this.send({ type: "error", payload: { message: "Failed to produce" } });
                    }
                    break;
                }

                case "resume-consumer": {
                    if (!this.userId) return;
                    const { consumerId } = parsedData.payload ?? {};
                    if (!consumerId) return;
                    try {
                        await MediaManager.getInstance().resumeConsumer(this.userId, consumerId);
                    } catch (err) {
                        console.error("Failed to resume consumer:", err);
                    }
                    break;
                }
            }
        });
    }

    destroy() {
        if (this.spaceId) {
            const spaceId = this.spaceId;

            // Remove media peer first (closes transports, producers, consumers)
            if (this.userId) {
                MediaManager.getInstance().removePeer(this.userId);
            }

            // This tell all other users that you left the room 
            RoomManager.getInstance().broadcast({
                type: "user-leave",
                payload: {
                    userId: this.userId,
                    spaceId: spaceId
                }
            }, this, spaceId);

            RoomManager.getInstance().removeUser(this, spaceId);

            // Recompute proximity for remaining users after this user leaves
            RoomManager.getInstance().updateProximity(spaceId);
        }
    }

    send(payload: Message) {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        }
    }
}
