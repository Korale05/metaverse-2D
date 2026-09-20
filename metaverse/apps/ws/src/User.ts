
import WebSocket from "ws";
import { Message } from "./types.js";
import { RoomManager } from "./RoomManager.js";
import prisma from "@repo/db";
import jwt, { JwtPayload } from "jsonwebtoken";

function randomString() {
    return Math.random().toString(36).substring(2, 10);
}

export class User {
    public id: string;
    private spaceId?: string;
    private x: number;
    private y: number;
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

                    const JWT_PASSWORD = process.env.JWT_PASSWORD ?? "IloveOnkar";
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
                        .map((e) => ({ id: e.userId ?? e.id, userId: e.userId ?? e.id, x: e.x, y: e.y }));

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
                        this.x = moveX;
                        this.y = moveY;
                        RoomManager.getInstance().broadcast({
                            type: "move",
                            payload: {
                                x: this.x,
                                y: this.y,
                                userId: this.userId
                            }
                        }, this, this.spaceId);
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
            }
        });
    }

    destroy() {
        if (this.spaceId) {
            // This tell all other users that you left the room 
            RoomManager.getInstance().broadcast({
                type: "user-leave",
                payload: {
                    userId: this.userId,
                    spaceId: this.spaceId
                }
            }, this, this.spaceId);

            RoomManager.getInstance().removeUser(this, this.spaceId);
        }
    }

    send(payload: Message) {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        }
    }
}
