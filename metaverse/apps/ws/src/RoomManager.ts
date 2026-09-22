import { User } from "./User.js";
import { Message } from "./types.js";
import { MediaManager } from "./mediaManager.js";

export class RoomManager {

    rooms: Map<string, User[]> = new Map();

    /**
     * Cache of the last proximity signature sent to each user.
     * Key: userId, Value: JSON-stringified sorted array of nearby userIds.
     * Used to avoid sending duplicate PROXIMITY_UPDATE messages.
     */
    private lastSentProximity: Map<string, string> = new Map();

    static instance: RoomManager;

    private constructor() {
        this.rooms = new Map();
    }

    static getInstance() {
        if (!this.instance) {
            this.instance = new RoomManager();
        }
        return this.instance;
    }

    public addUser(spaceId: string, user: User) {
        if (!this.rooms.has(spaceId)) {
            this.rooms.set(spaceId, [user]);
            return;
        }

        this.rooms.set(spaceId, [...(this.rooms.get(spaceId) ?? []), user]);
    }

    public broadcast(message: Message, user: User, roomId: string) {
        if (!this.rooms.has(roomId)) {
            return;
        }
        this.rooms.get(roomId)?.forEach((u) => {
            if (u.id != user.id) {
                u.send(message);
            }
        });
    }

    public removeUser(user: User, spaceId: string) {
        if (!this.rooms.has(spaceId)) {
            return;
        }
        this.rooms.set(spaceId, this.rooms.get(spaceId)?.filter((u) => u.id != user.id) ?? []);

        // Clean up proximity cache for the removed user
        if (user.userId) {
            this.lastSentProximity.delete(user.userId);
        }
    }

    /**
     * Build connected components of users on the grid via BFS flood-fill.
     * Two users are in the same group if there's a chain of adjacent (Manhattan distance 1)
     * users connecting them — transitive grouping.
     */
    public computeGroups(spaceId: string): User[][] {
        const users = this.rooms.get(spaceId);
        if (!users || users.length === 0) return [];

        // Build a position -> User map for quick 4-neighbor lookup
        const posMap = new Map<string, User>();
        for (const user of users) {
            const key = `${user.x},${user.y}`;
            posMap.set(key, user);
        }

        const visited = new Set<string>(); // track visited user connection ids
        const groups: User[][] = [];

        for (const user of users) {
            if (visited.has(user.id)) continue;

            // BFS flood-fill from this user
            const group: User[] = [];
            const queue: User[] = [user];
            visited.add(user.id);

            while (queue.length > 0) {
                const current = queue.shift()!;
                group.push(current);

                // Check all 4 neighbors (up, down, left, right)
                const neighbors = [
                    { x: current.x, y: current.y - 1 },
                    { x: current.x, y: current.y + 1 },
                    { x: current.x - 1, y: current.y },
                    { x: current.x + 1, y: current.y },
                ];

                for (const pos of neighbors) {
                    const key = `${pos.x},${pos.y}`;
                    const neighbor = posMap.get(key);
                    if (neighbor && !visited.has(neighbor.id)) {
                        visited.add(neighbor.id);
                        queue.push(neighbor);
                    }
                }
            }

            groups.push(group);
        }

        return groups;
    }

    /**
     * Recompute proximity groups for a space and send PROXIMITY_UPDATE
     * to each user whose nearby set has changed since the last notification.
     * Sends stable userId strings (not connection ids).
     */
    public updateProximity(spaceId: string): void {
        const users = this.rooms.get(spaceId);
        if (!users) return;

        const groups = this.computeGroups(spaceId);

        // Build a userId -> nearby userId[] map from the groups
        const proximityMap = new Map<string, string[]>();

        for (const group of groups) {
            if (group.length < 2) {
                // Solo user — their nearby is empty
                for (const user of group) {
                    if (user.userId) {
                        proximityMap.set(user.userId, []);
                    }
                }
                continue;
            }

            // Multi-user group — each member's nearby is all OTHER members
            for (const user of group) {
                if (!user.userId) continue;
                const nearby = group
                    .filter((u) => u.userId && u.userId !== user.userId)
                    .map((u) => u.userId!)
                    .sort();
                proximityMap.set(user.userId, nearby);
            }
        }

        // Send PROXIMITY_UPDATE only when the set has changed
        for (const [userId, nearby] of proximityMap) {
            const signature = JSON.stringify(nearby);
            const lastSignature = this.lastSentProximity.get(userId);

            if (signature !== lastSignature) {
                this.lastSentProximity.set(userId, signature);

                // Find the user object to send to
                const user = users.find((u) => u.userId === userId);
                if (user) {
                    user.send({
                        type: "PROXIMITY_UPDATE",
                        payload: {
                            nearby: nearby
                        }
                    });
                }

                // Bridge proximity → media: sync consumers for this user
                if (MediaManager.getInstance().hasPeer(userId)) {
                    MediaManager.getInstance().syncConsumers(userId, nearby);
                }
            }
        }
    }
}