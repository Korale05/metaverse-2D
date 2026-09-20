import axios from "axios";

const BACKEND_URL = "http://localhost:3000";

function createDummyJWT(payload) {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = Buffer.from("fakesignature").toString("base64url");
    return `${header}.${body}.${signature}`;
}

// Axios instance configured to not throw on 4xx/5xx status codes for flexible assertions
const api = axios.create({
    baseURL: BACKEND_URL,
    validateStatus: () => true,
});

// Helper function to create a new unique user and return user info with auth headers
async function signupAndSignin(role = "user", customPassword = "securePassword123") {
    const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
    const username = `user_${uniqueSuffix}`;
    const password = customPassword;

    const signupRes = await api.post("/api/v1/signup", {
        username,
        password,
        type: role,
    });
    expect(signupRes.status).toBe(200);
    const userId = signupRes.data.userId;

    const signinRes = await api.post("/api/v1/signin", {
        username,
        password,
    });
    expect(signinRes.status).toBe(200);
    const token = signinRes.data.accessToken;
    const refreshToken = signinRes.data.refreshToken;

    const authHeaders = {
        headers: {
            Cookie: `accessToekn=${token}`,
            Authorization: token,
        },
    };

    const cookieOnlyAuth = {
        headers: {
            Cookie: `accessToekn=${token}`,
        },
    };

    const headerOnlyAuth = {
        headers: {
            Authorization: token,
        },
    };

    return {
        userId,
        username,
        password,
        token,
        refreshToken,
        authHeaders,
        cookieOnlyAuth,
        headerOnlyAuth,
    };
}

// Helper to create an avatar for testing
async function createAvatar(name = "Test Avatar", imageUrl = "https://example.com/avatar.png") {
    const res = await api.post("/api/v1/admin/avatar", {
        name,
        imageUrl,
    });
    return res.data.avatarId;
}

// Helper to create an element for testing
async function createElement(width = 10, height = 10, imageUrl = "https://example.com/element.png", isStatic = true) {
    const res = await api.post("/api/v1/admin/element", {
        width,
        height,
        imageUrl,
        static: isStatic,
    });
    return res.data.id;
}

// =========================================================================
// 1. Authentication Endpoints (/api/v1) - Standard & Extreme Edge Cases
// =========================================================================
describe("1. Authentication Endpoints (/api/v1)", () => {
    describe("POST /api/v1/signup", () => {
        test("should successfully sign up a standard user", async () => {
            const username = `user_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
            const res = await api.post("/api/v1/signup", {
                username,
                password: "password123",
                type: "user",
            });

            expect(res.status).toBe(200);
            expect(res.data).toHaveProperty("userId");
            expect(typeof res.data.userId).toBe("string");
            expect(res.data.msg).toBe("Successfully Signup...");
        });

        test("should successfully sign up an admin", async () => {
            const username = `admin_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
            const res = await api.post("/api/v1/signup", {
                username,
                password: "password123",
                type: "admin",
            });

            expect(res.status).toBe(200);
            expect(res.data).toHaveProperty("userId");
            expect(typeof res.data.userId).toBe("string");
        });

        test("should succeed with exact boundary password length (6 characters)", async () => {
            const username = `minpass_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
            const res = await api.post("/api/v1/signup", {
                username,
                password: "123456", // 6 chars minimum for signup
                type: "user",
            });

            expect(res.status).toBe(200);
            expect(res.data).toHaveProperty("userId");
        });

        test("should fail when password is less than 6 characters (5 characters)", async () => {
            const username = `shortpass_${Date.now()}`;
            const res = await api.post("/api/v1/signup", {
                username,
                password: "12345", // 5 chars -> fail
                type: "user",
            });

            expect(res.status).toBe(400);
            expect(res.data.message).toBe("Zod Validation failed!");
        });

        test("should successfully sign up with complex unicode, emojis, and special characters in username & password", async () => {
            const uniqueId = Math.floor(Math.random() * 100000);
            const username = `user_🚀_ñ_@#$_${Date.now()}_${uniqueId}`;
            const password = "P@$$w0rd_🔥_100%_Valid!~";

            const res = await api.post("/api/v1/signup", {
                username,
                password,
                type: "user",
            });

            expect(res.status).toBe(200);
            expect(res.data).toHaveProperty("userId");
        });

        test("should handle very long passwords (e.g., 200 characters)", async () => {
            const username = `longpwd_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
            const longPassword = "A".repeat(200) + "123!";

            const res = await api.post("/api/v1/signup", {
                username,
                password: longPassword,
                type: "user",
            });

            expect(res.status).toBe(200);
            expect(res.data).toHaveProperty("userId");
        });

        test("should fail when signing up with an already existing username", async () => {
            const username = `dup_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
            const firstRes = await api.post("/api/v1/signup", {
                username,
                password: "password123",
                type: "user",
            });
            expect(firstRes.status).toBe(200);

            const dupRes = await api.post("/api/v1/signup", {
                username,
                password: "password123",
                type: "user",
            });
            expect(dupRes.status).toBe(400);
            expect(dupRes.data.message).toBe("Username already exists");
        });

        test("should treat different casing as distinct usernames", async () => {
            const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
            const userLower = `case_test_${suffix}`;
            const userUpper = `CASE_TEST_${suffix}`;

            const res1 = await api.post("/api/v1/signup", {
                username: userLower,
                password: "password123",
                type: "user",
            });
            expect(res1.status).toBe(200);

            const res2 = await api.post("/api/v1/signup", {
                username: userUpper,
                password: "password123",
                type: "user",
            });
            expect(res2.status).toBe(200);
            expect(res1.data.userId).not.toBe(res2.data.userId);
        });

        test("should fail if required fields are missing", async () => {
            const res1 = await api.post("/api/v1/signup", {
                password: "password123",
                type: "user",
            });
            expect(res1.status).toBe(400);
            expect(res1.data.message).toBe("Zod Validation failed!");

            const res2 = await api.post("/api/v1/signup", {
                username: "some_user_123",
                type: "user",
            });
            expect(res2.status).toBe(400);
            expect(res2.data.message).toBe("Zod Validation failed!");

            const res3 = await api.post("/api/v1/signup", {
                username: "some_user_123",
                password: "password123",
            });
            expect(res3.status).toBe(400);
            expect(res3.data.message).toBe("Zod Validation failed!");
        });

        test("should fail if payload is an empty object or null/array", async () => {
            const res1 = await api.post("/api/v1/signup", {});
            expect(res1.status).toBe(400);
            expect(res1.data.message).toBe("Zod Validation failed!");

            const res2 = await api.post("/api/v1/signup", []);
            expect(res2.status).toBe(400);
            expect(res2.data.message).toBe("Zod Validation failed!");
        });

        test("should fail if type is invalid (e.g., 'guest', 'superadmin', uppercase 'USER')", async () => {
            const invalidTypes = ["guest", "superadmin", "USER", "ADMIN", "moderator", "", 123, true];

            for (const type of invalidTypes) {
                const res = await api.post("/api/v1/signup", {
                    username: `invalid_type_${Date.now()}_${Math.random()}`,
                    password: "password123",
                    type,
                });
                expect(res.status).toBe(400);
                expect(res.data.message).toBe("Zod Validation failed!");
            }
        });

        test("should fail with invalid data types for username and password", async () => {
            const testCases = [
                { username: 12345, password: "password123", type: "user" },
                { username: true, password: "password123", type: "user" },
                { username: "validuser", password: 12345678, type: "user" },
                { username: {}, password: "password123", type: "user" },
                { username: "validuser", password: [], type: "user" },
            ];

            for (const payload of testCases) {
                const res = await api.post("/api/v1/signup", payload);
                expect(res.status).toBe(400);
                expect(res.data.message).toBe("Zod Validation failed!");
            }
        });

        test("should handle concurrent signup attempts for the same username gracefully", async () => {
            const username = `concurrent_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
            const promises = Array(4).fill(null).map(() =>
                api.post("/api/v1/signup", {
                    username,
                    password: "password123",
                    type: "user",
                })
            );

            const results = await Promise.all(promises);
            const successCount = results.filter((r) => r.status === 200).length;
            const duplicateCount = results.filter((r) => r.status === 400 && r.data.message === "Username already exists").length;

            expect(successCount).toBe(1);
            expect(duplicateCount).toBe(3);
        });
    });

    describe("POST /api/v1/signin", () => {
        let testUser;

        beforeAll(async () => {
            testUser = await signupAndSignin("user", "myValidPassword123");
        });

        test("should successfully sign in with correct credentials", async () => {
            const res = await api.post("/api/v1/signin", {
                username: testUser.username,
                password: testUser.password,
            });

            expect(res.status).toBe(200);
            expect(res.data).toHaveProperty("accessToken");
            expect(res.data).toHaveProperty("refreshToken");
            expect(typeof res.data.accessToken).toBe("string");
            expect(typeof res.data.refreshToken).toBe("string");
            expect(res.data.msg).toBe("Successfully SignIn ......");

            // Check set-cookie headers
            const cookies = res.headers["set-cookie"] || [];
            const cookieString = cookies.join("; ");
            expect(cookieString).toContain("accessToekn=");
            expect(cookieString).toContain("refreshToken=");
        });

        test("should fail when username does not exist", async () => {
            const res = await api.post("/api/v1/signin", {
                username: `non_existent_${Date.now()}_${Math.random()}`,
                password: "securePassword123",
            });

            expect(res.status).toBe(400);
            expect(res.data.msg).toBe("User not found please SignUp First ......");
        });

        test("should fail when password is incorrect", async () => {
            const res = await api.post("/api/v1/signin", {
                username: testUser.username,
                password: "wrongPassword123",
            });

            expect(res.status).toBe(400);
            expect(res.data.msg).toBe("Password is incorrect ....");
        });

        test("should fail validation when password is shorter than 8 characters (SigninSchema min 8)", async () => {
            const res = await api.post("/api/v1/signin", {
                username: testUser.username,
                password: "1234567", // 7 chars -> fails signin zod schema
            });

            expect(res.status).toBe(400);
            expect(res.data.message).toBe("Zod Validation failed!");
        });

        test("should succeed with boundary password length of exactly 8 characters", async () => {
            const username = `exact8_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
            const password = "pass1234"; // exactly 8 chars

            await api.post("/api/v1/signup", {
                username,
                password,
                type: "user",
            });

            const res = await api.post("/api/v1/signin", {
                username,
                password,
            });

            expect(res.status).toBe(200);
            expect(res.data).toHaveProperty("accessToken");
        });

        test("should fail if username or password is missing or empty in signin", async () => {
            const res1 = await api.post("/api/v1/signin", { password: "securePassword123" });
            expect(res1.status).toBe(400);
            expect(res1.data.message).toBe("Zod Validation failed!");

            const res2 = await api.post("/api/v1/signin", { username: testUser.username });
            expect(res2.status).toBe(400);
            expect(res2.data.message).toBe("Zod Validation failed!");

            const res3 = await api.post("/api/v1/signin", {});
            expect(res3.status).toBe(400);
            expect(res3.data.message).toBe("Zod Validation failed!");
        });

        test("should fail when password has incorrect casing", async () => {
            const res = await api.post("/api/v1/signin", {
                username: testUser.username,
                password: testUser.password.toUpperCase(),
            });

            expect(res.status).toBe(400);
            expect(res.data.msg).toBe("Password is incorrect ....");
        });
    });
});

// =========================================================================
// 2. Public Information Endpoints (/api/v1) - Standard & Extreme Edge Cases
// =========================================================================
describe("2. Public Information Endpoints (/api/v1)", () => {
    test("GET /api/v1/avatars - should return list of available avatars with valid structure", async () => {
        // Ensure at least one avatar exists
        const avatarId = await createAvatar("Public Avatar", "https://example.com/pub_avatar.png");

        const res = await api.get("/api/v1/avatars");

        expect(res.status).toBe(200);
        expect(res.data).toHaveProperty("avatar");
        expect(Array.isArray(res.data.avatar)).toBe(true);
        expect(res.data.avatar.length).toBeGreaterThan(0);

        // Verify structure of avatar objects
        const avatar = res.data.avatar.find((a) => a.id === avatarId);
        expect(avatar).toBeDefined();
        expect(avatar).toHaveProperty("id");
        expect(avatar).toHaveProperty("name", "Public Avatar");
        expect(avatar).toHaveProperty("imageUrl", "https://example.com/pub_avatar.png");
    });

    test("GET /api/v1/elements - should return list of available elements with valid structure", async () => {
        // Ensure at least one element exists
        const elementId = await createElement(12, 14, "https://example.com/pub_element.png", true);

        const res = await api.get("/api/v1/elements");

        expect(res.status).toBe(200);
        expect(res.data).toHaveProperty("element");
        expect(Array.isArray(res.data.element)).toBe(true);
        expect(res.data.element.length).toBeGreaterThan(0);

        // Verify structure of element objects
        const element = res.data.element.find((e) => e.id === elementId);
        expect(element).toBeDefined();
        expect(element).toHaveProperty("id");
        expect(element).toHaveProperty("width", 12);
        expect(element).toHaveProperty("height", 14);
        expect(element).toHaveProperty("imageUrl", "https://example.com/pub_element.png");
        expect(element).toHaveProperty("static", true);
    });

    test("GET /api/v1/avatars and /elements - should succeed even with arbitrary query params or extra headers", async () => {
        const resAvatars = await api.get("/api/v1/avatars?filter=all&page=1&limit=100", {
            headers: { "X-Custom-Header": "test-value" },
        });
        expect(resAvatars.status).toBe(200);
        expect(Array.isArray(resAvatars.data.avatar)).toBe(true);

        const resElements = await api.get("/api/v1/elements?foo=bar&debug=true");
        expect(resElements.status).toBe(200);
        expect(Array.isArray(resElements.data.element)).toBe(true);
    });
});

// =========================================================================
// 3. User Endpoints (/api/v1/user) - Standard & Extreme Edge Cases
// =========================================================================
describe("3. User Endpoints (/api/v1/user)", () => {
    let user;
    let avatarId1;
    let avatarId2;

    beforeAll(async () => {
        user = await signupAndSignin("user");
        avatarId1 = await createAvatar("User Avatar 1", "https://example.com/user_avatar_1.png");
        avatarId2 = await createAvatar("User Avatar 2", "https://example.com/user_avatar_2.png");
    });

    describe("POST /api/v1/user/metadata", () => {
        test("should successfully update user avatar metadata via Cookie auth", async () => {
            const res = await api.post(
                "/api/v1/user/metadata",
                { avatarId: avatarId1 },
                user.cookieOnlyAuth
            );

            expect(res.status).toBe(200);
            expect(res.data.msg).toBe("Successfully updated the metadata");
            expect(res.data.avatarId).toBe(avatarId1);
        });

        test("should successfully update user avatar metadata", async () => {
            const res = await api.post(
                "/api/v1/user/metadata",
                { avatarId: avatarId2 },
                user.authHeaders
            );

            expect(res.status).toBe(200);
            expect(res.data.msg).toBe("Successfully updated the metadata");
            expect(res.data.avatarId).toBe(avatarId2);
        });

        test("should allow consecutive updates and reflect latest avatarId", async () => {
            const res1 = await api.post("/api/v1/user/metadata", { avatarId: avatarId1 }, user.authHeaders);
            expect(res1.status).toBe(200);
            expect(res1.data.avatarId).toBe(avatarId1);

            const res2 = await api.post("/api/v1/user/metadata", { avatarId: avatarId2 }, user.authHeaders);
            expect(res2.status).toBe(200);
            expect(res2.data.avatarId).toBe(avatarId2);
        });

        test("should fail to update metadata without authentication", async () => {
            const res = await api.post("/api/v1/user/metadata", { avatarId: avatarId1 });

            expect(res.status).toBe(400);
            expect(res.data.msg).toBe("token is not present");
        });

        test("should fail when avatarId is missing or empty object is passed", async () => {
            const res1 = await api.post("/api/v1/user/metadata", {}, user.authHeaders);
            expect(res1.status).toBe(400);
            expect(res1.data.message).toBe("Zod Validation Failed!");

            const res2 = await api.post("/api/v1/user/metadata", { avatarId: 12345 }, user.authHeaders);
            expect(res2.status).toBe(400);
            expect(res2.data.message).toBe("Zod Validation Failed!");

            const res3 = await api.post("/api/v1/user/metadata", { avatarId: null }, user.authHeaders);
            expect(res3.status).toBe(400);
            expect(res3.data.message).toBe("Zod Validation Failed!");
        });

        test("should fail when token is invalid or malformed", async () => {
            const res = await api.post(
                "/api/v1/user/metadata",
                { avatarId: avatarId1 },
                {
                    headers: {
                        Authorization: "Bearer invalid.token.signature",
                    },
                }
            );

            expect(res.status).toBe(400);
        });
    });

    describe("GET /api/v1/user/metadata/bulk", () => {
        let userA;
        let userB;
        let userC;

        beforeAll(async () => {
            userA = await signupAndSignin("user");
            userB = await signupAndSignin("user");
            userC = await signupAndSignin("user");

            await api.post("/api/v1/user/metadata", { avatarId: avatarId1 }, userA.authHeaders);
            await api.post("/api/v1/user/metadata", { avatarId: avatarId2 }, userB.authHeaders);
        });

        test("should successfully retrieve metadata for specified user IDs", async () => {
            const idsQuery = JSON.stringify([userA.userId, userB.userId, userC.userId]);
            const res = await api.get(`/api/v1/user/metadata/bulk?ids=${encodeURIComponent(idsQuery)}`);

            expect(res.status).toBe(200);
            expect(res.data).toHaveProperty("userMetaData");
            expect(Array.isArray(res.data.userMetaData)).toBe(true);

            const foundUserA = res.data.userMetaData.find((u) => u.userId === userA.userId);
            const foundUserB = res.data.userMetaData.find((u) => u.userId === userB.userId);
            const foundUserC = res.data.userMetaData.find((u) => u.userId === userC.userId);

            expect(foundUserA).toBeDefined();
            expect(foundUserA.username).toBe(userA.username);
            expect(foundUserA.avatarId).toBe(avatarId1);

            expect(foundUserB).toBeDefined();
            expect(foundUserB.username).toBe(userB.username);
            expect(foundUserB.avatarId).toBe(avatarId2);

            expect(foundUserC).toBeDefined();
            expect(foundUserC.username).toBe(userC.username);
            expect(foundUserC.avatarId).toBeNull();
        });

        test("should handle single user ID in array", async () => {
            const idsQuery = JSON.stringify([userA.userId]);
            const res = await api.get(`/api/v1/user/metadata/bulk?ids=${encodeURIComponent(idsQuery)}`);

            expect(res.status).toBe(200);
            expect(res.data.userMetaData.length).toBe(1);
            expect(res.data.userMetaData[0].userId).toBe(userA.userId);
        });

        test("should return empty array when no user IDs match", async () => {
            const nonExistentIds = JSON.stringify(["non_existent_1", "non_existent_2"]);
            const res = await api.get(`/api/v1/user/metadata/bulk?ids=${encodeURIComponent(nonExistentIds)}`);

            expect(res.status).toBe(200);
            expect(res.data).toHaveProperty("userMetaData");
            expect(res.data.userMetaData).toEqual([]);
        });

        test("should return empty array when querying with empty list []", async () => {
            const emptyQuery = JSON.stringify([]);
            const res = await api.get(`/api/v1/user/metadata/bulk?ids=${encodeURIComponent(emptyQuery)}`);

            expect(res.status).toBe(200);
            expect(res.data.userMetaData).toEqual([]);
        });

        test("should handle duplicate IDs in query array without breaking", async () => {
            const dupQuery = JSON.stringify([userA.userId, userA.userId, userA.userId]);
            const res = await api.get(`/api/v1/user/metadata/bulk?ids=${encodeURIComponent(dupQuery)}`);

            expect(res.status).toBe(200);
            expect(res.data.userMetaData.length).toBe(1);
            expect(res.data.userMetaData[0].userId).toBe(userA.userId);
        });

        test("should handle large list of IDs gracefully", async () => {
            const largeIds = [userA.userId, ...Array(25).fill(null).map((_, i) => `fake_user_id_${i}`)];
            const idsQuery = JSON.stringify(largeIds);
            const res = await api.get(`/api/v1/user/metadata/bulk?ids=${encodeURIComponent(idsQuery)}`);

            expect(res.status).toBe(200);
            expect(res.data.userMetaData.length).toBe(1);
            expect(res.data.userMetaData[0].userId).toBe(userA.userId);
        });
    });
});

// =========================================================================
// 4. Admin Endpoints (/api/v1/admin) - Standard & Extreme Edge Cases
// =========================================================================
describe("4. Admin Endpoints (/api/v1/admin)", () => {
    describe("POST /api/v1/admin/element", () => {
        test("should successfully create a new element with static=true", async () => {
            const res = await api.post("/api/v1/admin/element", {
                width: 32,
                height: 32,
                imageUrl: "https://example.com/chair.png",
                static: true,
            });

            expect(res.status).toBe(200);
            expect(res.data.msg).toBe("Element Created Successfully !");
            expect(res.data).toHaveProperty("id");
            expect(typeof res.data.id).toBe("string");
        });

        test("should successfully create an element with static=false", async () => {
            const res = await api.post("/api/v1/admin/element", {
                width: 64,
                height: 64,
                imageUrl: "https://example.com/npc.png",
                static: false,
            });

            expect(res.status).toBe(200);
            expect(res.data).toHaveProperty("id");
        });

        test("should handle extreme boundary dimensions (e.g., 0, 1, 100000)", async () => {
            const resZero = await api.post("/api/v1/admin/element", {
                width: 0,
                height: 0,
                imageUrl: "https://example.com/point.png",
                static: true,
            });
            expect(resZero.status).toBe(200);

            const resLarge = await api.post("/api/v1/admin/element", {
                width: 100000,
                height: 100000,
                imageUrl: "https://example.com/huge_world.png",
                static: false,
            });
            expect(resLarge.status).toBe(200);
        });

        test("should fail with validation error when required fields are missing", async () => {
            const testCases = [
                { width: 32, height: 32, imageUrl: "https://example.com/test.png" }, // missing static
                { width: 32, height: 32, static: true }, // missing imageUrl
                { height: 32, imageUrl: "https://example.com/test.png", static: true }, // missing width
                { width: 32, imageUrl: "https://example.com/test.png", static: true }, // missing height
                {}, // empty
            ];

            for (const payload of testCases) {
                const res = await api.post("/api/v1/admin/element", payload);
                expect(res.status).toBe(400);
                expect(res.data.message).toBe("Zod Validation Failed!");
            }
        });

        test("should fail when field types are invalid (strings for numbers, boolean for imageUrl)", async () => {
            const invalidPayloads = [
                { width: "32", height: 32, imageUrl: "https://example.com/test.png", static: true },
                { width: 32, height: "32", imageUrl: "https://example.com/test.png", static: true },
                { width: 32, height: 32, imageUrl: 12345, static: true },
                { width: 32, height: 32, imageUrl: "https://example.com/test.png", static: "true" },
            ];

            for (const payload of invalidPayloads) {
                const res = await api.post("/api/v1/admin/element", payload);
                expect(res.status).toBe(400);
                expect(res.data.message).toBe("Zod Validation Failed!");
            }
        });
    });

    describe("PUT /api/v1/admin/element/:elementId", () => {
        let elementId;

        beforeEach(async () => {
            elementId = await createElement(20, 20, "https://example.com/initial.png", false);
        });

        test("should successfully update an existing element's imageUrl", async () => {
            const res = await api.put(`/api/v1/admin/element/${elementId}`, {
                imageUrl: "https://example.com/updated.png",
            });

            expect(res.status).toBe(200);
            expect(res.data.msg).toBe("Element Updated Successfully !");
        });

        test("should handle complex / long data URIs as imageUrl", async () => {
            const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
            const res = await api.put(`/api/v1/admin/element/${elementId}`, {
                imageUrl: dataUri,
            });

            expect(res.status).toBe(200);
            expect(res.data.msg).toBe("Element Updated Successfully !");
        });

        test("should fail when imageUrl is missing or empty object", async () => {
            const res = await api.put(`/api/v1/admin/element/${elementId}`, {});

            expect(res.status).toBe(400);
            expect(res.data.message).toBe("Zod Validation Failed!");
        });

        test("should fail when imageUrl is not a string", async () => {
            const res = await api.put(`/api/v1/admin/element/${elementId}`, {
                imageUrl: 99999,
            });

            expect(res.status).toBe(400);
            expect(res.data.message).toBe("Zod Validation Failed!");
        });
    });

    describe("POST /api/v1/admin/avatar", () => {
        test("should successfully create a new avatar", async () => {
            const res = await api.post("/api/v1/admin/avatar", {
                name: "Cyber Ninja",
                imageUrl: "https://example.com/ninja.png",
            });

            expect(res.status).toBe(200);
            expect(res.data.msg).toBe("Avatar Created successfully !");
            expect(res.data).toHaveProperty("avatarId");
            expect(typeof res.data.avatarId).toBe("string");
        });

        test("should handle avatars with emojis, unicode, and symbols in name", async () => {
            const res = await api.post("/api/v1/admin/avatar", {
                name: "👑 King of Meta 🥷 (V2.0)",
                imageUrl: "https://example.com/avatar_king.png",
            });

            expect(res.status).toBe(200);
            expect(res.data).toHaveProperty("avatarId");
        });

        test("should fail when name or imageUrl is missing", async () => {
            const res1 = await api.post("/api/v1/admin/avatar", {
                name: "Incomplete Avatar",
            });
            expect(res1.status).toBe(400);
            expect(res1.data.message).toBe("Zod Validation Failed!");

            const res2 = await api.post("/api/v1/admin/avatar", {
                imageUrl: "https://example.com/image_only.png",
            });
            expect(res2.status).toBe(400);
            expect(res2.data.message).toBe("Zod Validation Failed!");
        });

        test("should fail when name or imageUrl has invalid data type", async () => {
            const res = await api.post("/api/v1/admin/avatar", {
                name: 12345,
                imageUrl: true,
            });

            expect(res.status).toBe(400);
            expect(res.data.message).toBe("Zod Validation Failed!");
        });
    });

    describe("GET /api/v1/admin/map (Create Map)", () => {
        let elementId1;
        let elementId2;

        beforeAll(async () => {
            elementId1 = await createElement(10, 10, "https://example.com/tile1.png", true);
            elementId2 = await createElement(20, 20, "https://example.com/tile2.png", false);
        });

        test("should successfully create a new map with multiple default elements", async () => {
            const res = await api.get("/api/v1/admin/map", {
                data: {
                    name: "Office Floor Deluxe",
                    thumbnail: "https://example.com/office_thumb.png",
                    dimension: "500x300",
                    defaultElements: [
                        { elementId: elementId1, x: 5, y: 10 },
                        { elementId: elementId2, x: 50, y: 100 },
                    ],
                },
            });

            expect(res.status).toBe(200);
            expect(res.data.msg).toBe("Map Created Successfully !");
            expect(res.data).toHaveProperty("mapId");
            expect(typeof res.data.mapId).toBe("string");
        });

        test("should successfully create a map with empty defaultElements array", async () => {
            const res = await api.get("/api/v1/admin/map", {
                data: {
                    name: "Empty Grassland",
                    thumbnail: "https://example.com/grass.png",
                    dimension: "100x100",
                    defaultElements: [],
                },
            });

            expect(res.status).toBe(200);
            expect(res.data).toHaveProperty("mapId");
        });

        test("should handle defaultElements with boundary coordinates (0, negative, large)", async () => {
            const res = await api.get("/api/v1/admin/map", {
                data: {
                    name: "Coordinate Test Map",
                    thumbnail: "https://example.com/coord.png",
                    dimension: "1000x1000",
                    defaultElements: [
                        { elementId: elementId1, x: 0, y: 0 },
                        { elementId: elementId2, x: 999, y: 999 },
                    ],
                },
            });

            expect(res.status).toBe(200);
            expect(res.data).toHaveProperty("mapId");
        });

        test("should fail map creation when schema is invalid or missing required fields", async () => {
            const invalidPayloads = [
                { name: "Broken Map 1" }, // missing dimension, thumbnail, defaultElements
                { name: "Broken Map 2", thumbnail: "https://example.com/thumb.png", dimension: "100x100" }, // missing defaultElements
                {
                    name: "Broken Map 3",
                    thumbnail: "https://example.com/thumb.png",
                    dimension: "100x100",
                    defaultElements: [{ elementId: elementId1, x: "not_a_number", y: 10 }], // invalid x
                },
                {
                    name: "Broken Map 4",
                    thumbnail: "https://example.com/thumb.png",
                    dimension: "100x100",
                    defaultElements: [{ x: 5, y: 10 }], // missing elementId
                },
            ];

            for (const data of invalidPayloads) {
                const res = await api.get("/api/v1/admin/map", { data });
                expect(res.status).toBe(400);
                expect(res.data.message).toBe("Zod Validation Failed!");
            }
        });
    });
});

// =========================================================================
// 5. Space Endpoints (/api/v1/space) - Standard & Extreme Edge Cases
// =========================================================================
describe("5. Space Endpoints (/api/v1/space)", () => {
    let owner;
    let otherUser;
    let testElementId;

    beforeAll(async () => {
        owner = await signupAndSignin("user");
        otherUser = await signupAndSignin("user");
        testElementId = await createElement(16, 16, "https://example.com/table.png", true);
    });

    describe("POST /api/v1/space (Create Space)", () => {
        test("should successfully create a standalone space (without mapId)", async () => {
            const res = await api.post(
                "/api/v1/space",
                {
                    name: "My Custom HQ",
                    dimensions: "200x300",
                    mapId: "",
                },
                owner.authHeaders
            );

            expect(res.status).toBe(200);
            expect(res.data.message).toBe("Space Created Successfully!");
            expect(res.data).toHaveProperty("spaceId");
            expect(typeof res.data.spaceId).toBe("string");
        });

        test("should successfully create space with extreme boundary dimensions", async () => {
            const res1 = await api.post(
                "/api/v1/space",
                {
                    name: "Tiny 1x1 Space",
                    dimensions: "1x1",
                    mapId: "",
                },
                owner.authHeaders
            );
            expect(res1.status).toBe(200);

            const res2 = await api.post(
                "/api/v1/space",
                {
                    name: "Gigantic Space",
                    dimensions: "50000x50000",
                    mapId: "",
                },
                owner.authHeaders
            );
            expect(res2.status).toBe(200);
        });

        test("should successfully create a space using an existing map and replicate all map elements", async () => {
            const elemA = await createElement(10, 10, "https://example.com/a.png", true);
            const elemB = await createElement(20, 20, "https://example.com/b.png", false);

            const mapRes = await api.get("/api/v1/admin/map", {
                data: {
                    name: "Complex Template Map",
                    thumbnail: "https://example.com/complex.png",
                    dimension: "250x350",
                    defaultElements: [
                        { elementId: elemA, x: 15, y: 25 },
                        { elementId: elemB, x: 100, y: 200 },
                    ],
                },
            });
            expect(mapRes.status).toBe(200);
            const mapId = mapRes.data.mapId;

            // Create space from map
            const res = await api.post(
                "/api/v1/space",
                {
                    name: "Space From Complex Map",
                    dimensions: "250x350",
                    mapId,
                },
                owner.authHeaders
            );

            expect(res.status).toBe(200);
            expect(res.data.message).toBe("Space Created Successfully!");
            expect(res.data).toHaveProperty("spaceId");

            // Verify space details and dimensions copied from map
            const spaceDetails = await api.get(`/api/v1/space/${res.data.spaceId}`, owner.authHeaders);
            expect(spaceDetails.status).toBe(200);
            expect(spaceDetails.data.width).toBe(250);
            expect(spaceDetails.data.height).toBe(350);
        });

        test("should fail space creation when mapId does not exist", async () => {
            const res = await api.post(
                "/api/v1/space",
                {
                    name: "Non-existent Map Space",
                    dimensions: "100x100",
                    mapId: "non_existent_map_id_12345",
                },
                owner.authHeaders
            );

            expect(res.status).toBe(400);
            expect(res.data.message).toBe("Map Not Found!");
        });

        test("should fail space creation without auth token", async () => {
            const res = await api.post("/api/v1/space", {
                name: "Unauthenticated Space",
                dimensions: "100x100",
                mapId: "",
            });

            expect(res.status).toBe(400);
            expect(res.data.msg).toBe("token is not present");
        });

        test("should fail space creation with invalid schema / missing fields", async () => {
            const res1 = await api.post("/api/v1/space", { name: "Missing Dimensions" }, owner.authHeaders);
            expect(res1.status).toBe(400);
            expect(res1.data.message).toBe("Zod Validation Failed!");

            const res2 = await api.post("/api/v1/space", { dimensions: "100x100" }, owner.authHeaders);
            expect(res2.status).toBe(400);
            expect(res2.data.message).toBe("Zod Validation Failed!");

            const res3 = await api.post("/api/v1/space", {}, owner.authHeaders);
            expect(res3.status).toBe(400);
            expect(res3.data.message).toBe("Zod Validation Failed!");
        });
    });

    describe("GET /api/v1/space/all", () => {
        test("should return all spaces created by authenticated user and maintain isolation between users", async () => {
            const user1 = await signupAndSignin("user");
            const user2 = await signupAndSignin("user");

            // User 1 creates 2 spaces
            await api.post("/api/v1/space", { name: "User1 Space 1", dimensions: "50x50", mapId: "" }, user1.authHeaders);
            await api.post("/api/v1/space", { name: "User1 Space 2", dimensions: "60x60", mapId: "" }, user1.authHeaders);

            // User 2 creates 1 space
            await api.post("/api/v1/space", { name: "User2 Space 1", dimensions: "70x70", mapId: "" }, user2.authHeaders);

            const res1 = await api.get("/api/v1/space/all", user1.authHeaders);
            expect(res1.status).toBe(200);
            expect(res1.data.msg).toBe("Successfully !");
            expect(Array.isArray(res1.data.space)).toBe(true);
            expect(res1.data.space.length).toBe(2);
            expect(res1.data.space.some((s) => s.name === "User1 Space 1")).toBe(true);
            expect(res1.data.space.some((s) => s.name === "User1 Space 2")).toBe(true);
            expect(res1.data.space.some((s) => s.name === "User2 Space 1")).toBe(false);

            const res2 = await api.get("/api/v1/space/all", user2.authHeaders);
            expect(res2.status).toBe(200);
            expect(res2.data.space.length).toBe(1);
            expect(res2.data.space[0].name).toBe("User2 Space 1");
        });

        test("should return empty array for user who has not created any space", async () => {
            const freshUser = await signupAndSignin("user");
            const res = await api.get("/api/v1/space/all", freshUser.authHeaders);

            expect(res.status).toBe(200);
            expect(res.data.space).toEqual([]);
        });

        test("should fail to list spaces without auth token", async () => {
            const res = await api.get("/api/v1/space/all");

            expect(res.status).toBe(400);
            expect(res.data.msg).toBe("token is not present");
        });
    });

    describe("GET /api/v1/space/:spaceId", () => {
        let spaceId;

        beforeAll(async () => {
            const createRes = await api.post(
                "/api/v1/space",
                {
                    name: "Get Single Space Detailed Test",
                    dimensions: "180x120",
                    mapId: "",
                },
                owner.authHeaders
            );
            spaceId = createRes.data.spaceId;
        });

        test("should return space details and dimensions correctly", async () => {
            const res = await api.get(`/api/v1/space/${spaceId}`, owner.authHeaders);

            expect(res.status).toBe(200);
            expect(res.data).toHaveProperty("width", 180);
            expect(res.data).toHaveProperty("height", 120);
            expect(res.data).toHaveProperty("elements");
            expect(Array.isArray(res.data.elements)).toBe(true);
        });

        test("should fail for non-existent spaceId", async () => {
            const res = await api.get("/api/v1/space/non_existent_space_id_99999", owner.authHeaders);

            expect(res.status).toBe(400);
            expect(res.data.msg).toBe("Space is not found !");
        });

        test("should fail without auth token", async () => {
            const res = await api.get(`/api/v1/space/${spaceId}`);

            expect(res.status).toBe(400);
            expect(res.data.msg).toBe("token is not present");
        });
    });

    describe("POST /api/v1/space/element (Add Element to Space)", () => {
        let spaceId;

        beforeEach(async () => {
            const createRes = await api.post(
                "/api/v1/space",
                {
                    name: "Space for Element Adding Tests",
                    dimensions: "200x200",
                    mapId: "",
                },
                owner.authHeaders
            );
            spaceId = createRes.data.spaceId;
        });

        test("should allow space creator to add an element at standard coordinates", async () => {
            const res = await api.post(
                "/api/v1/space/element",
                {
                    spaceId,
                    elementId: testElementId,
                    x: 10,
                    y: 20,
                },
                owner.authHeaders
            );

            expect(res.status).toBe(200);
            expect(res.data.msg).toBe("Element added successfully!");
            expect(res.data).toHaveProperty("spaceElement");
            expect(res.data.spaceElement.spaceId).toBe(spaceId);
            expect(res.data.spaceElement.elementId).toBe(testElementId);
            expect(res.data.spaceElement.x).toBe(10);
            expect(res.data.spaceElement.y).toBe(20);
        });

        test("should allow adding elements at coordinate boundary (0, 0)", async () => {
            const res = await api.post(
                "/api/v1/space/element",
                {
                    spaceId,
                    elementId: testElementId,
                    x: 0,
                    y: 0,
                },
                owner.authHeaders
            );

            expect(res.status).toBe(200);
            expect(res.data.spaceElement.x).toBe(0);
            expect(res.data.spaceElement.y).toBe(0);
        });

        test("should allow adding multiple elements to the same space", async () => {
            const res1 = await api.post(
                "/api/v1/space/element",
                { spaceId, elementId: testElementId, x: 5, y: 5 },
                owner.authHeaders
            );
            expect(res1.status).toBe(200);

            const res2 = await api.post(
                "/api/v1/space/element",
                { spaceId, elementId: testElementId, x: 30, y: 40 },
                owner.authHeaders
            );
            expect(res2.status).toBe(200);
            expect(res1.data.spaceElement.id).not.toBe(res2.data.spaceElement.id);
        });

        test("should fail when non-creator attempts to add element to someone else's space", async () => {
            const res = await api.post(
                "/api/v1/space/element",
                {
                    spaceId,
                    elementId: testElementId,
                    x: 10,
                    y: 20,
                },
                otherUser.authHeaders
            );

            expect(res.status).toBe(400);
            expect(res.data.msg).toBe("Space not found!");
        });

        test("should fail when adding element to non-existent spaceId", async () => {
            const res = await api.post(
                "/api/v1/space/element",
                {
                    spaceId: "non_existent_space_12345",
                    elementId: testElementId,
                    x: 10,
                    y: 20,
                },
                owner.authHeaders
            );

            expect(res.status).toBe(400);
            expect(res.data.msg).toBe("Space not found!");
        });

        test("should fail with invalid element data schema (missing or wrong types)", async () => {
            const testCases = [
                { spaceId, elementId: testElementId, x: 10 }, // missing y
                { spaceId, elementId: testElementId, y: 10 }, // missing x
                { spaceId, x: 10, y: 10 }, // missing elementId
                { elementId: testElementId, x: 10, y: 10 }, // missing spaceId
                { spaceId, elementId: testElementId, x: "10", y: 20 }, // string x
                { spaceId, elementId: testElementId, x: 10, y: "20" }, // string y
                {}, // empty
            ];

            for (const payload of testCases) {
                const res = await api.post("/api/v1/space/element", payload, owner.authHeaders);
                expect(res.status).toBe(400);
                expect(res.data.msg).toBe("Invalid Data!");
            }
        });

        test("should fail without auth token", async () => {
            const res = await api.post("/api/v1/space/element", {
                spaceId,
                elementId: testElementId,
                x: 10,
                y: 20,
            });

            expect(res.status).toBe(400);
            expect(res.data.msg).toBe("token is not present");
        });
    });

    describe("DELETE /api/v1/space/element (Delete Element from Space)", () => {
        let spaceId;
        let spaceElementId;

        beforeEach(async () => {
            const spaceRes = await api.post(
                "/api/v1/space",
                {
                    name: "Space for Deletion Tests",
                    dimensions: "100x100",
                    mapId: "",
                },
                owner.authHeaders
            );
            spaceId = spaceRes.data.spaceId;

            const elementRes = await api.post(
                "/api/v1/space/element",
                {
                    spaceId,
                    elementId: testElementId,
                    x: 5,
                    y: 5,
                },
                owner.authHeaders
            );
            spaceElementId = elementRes.data.spaceElement.id;
        });

        test("should fail when non-creator attempts to delete element", async () => {
            const res = await api.delete("/api/v1/space/element", {
                ...otherUser.authHeaders,
                data: { id: spaceElementId },
            });

            expect(res.status).toBe(400);
            expect(res.data.msg).toBe("Unauthroized access!");
        });

        test("should successfully allow creator to delete space element", async () => {
            const res = await api.delete("/api/v1/space/element", {
                ...owner.authHeaders,
                data: { id: spaceElementId },
            });

            expect(res.status).toBe(200);
            expect(res.data.msg).toBe("Element deleted successfully!");
            expect(res.data).toHaveProperty("deleteSpaceElement");
        });

        test("should fail when element does not exist", async () => {
            const res = await api.delete("/api/v1/space/element", {
                ...owner.authHeaders,
                data: { id: "non_existent_element_id_123" },
            });

            expect(res.status).toBe(400);
            expect(res.data.msg).toBe("Element not found!");
        });

        test("should fail on double-deletion (deleting an already deleted element)", async () => {
            const firstDelete = await api.delete("/api/v1/space/element", {
                ...owner.authHeaders,
                data: { id: spaceElementId },
            });
            expect(firstDelete.status).toBe(200);

            const secondDelete = await api.delete("/api/v1/space/element", {
                ...owner.authHeaders,
                data: { id: spaceElementId },
            });
            expect(secondDelete.status).toBe(400);
            expect(secondDelete.data.msg).toBe("Element not found!");
        });

        test("should fail when id is missing or invalid schema in delete element", async () => {
            const res1 = await api.delete("/api/v1/space/element", {
                ...owner.authHeaders,
                data: {},
            });
            expect(res1.status).toBe(400);
            expect(res1.data.msg).toBe("Invalid Data!");

            const res2 = await api.delete("/api/v1/space/element", {
                ...owner.authHeaders,
                data: { id: 12345 },
            });
            expect(res2.status).toBe(400);
            expect(res2.data.msg).toBe("Invalid Data!");
        });

        test("should fail to delete element without auth", async () => {
            const res = await api.delete("/api/v1/space/element", {
                data: { id: spaceElementId },
            });

            expect(res.status).toBe(400);
            expect(res.data.msg).toBe("token is not present");
        });
    });

    describe("DELETE /api/v1/space/:spaceId (Delete Space)", () => {
        let spaceId;

        beforeEach(async () => {
            const createRes = await api.post(
                "/api/v1/space",
                {
                    name: "Space to Delete Safely",
                    dimensions: "80x80",
                    mapId: "",
                },
                owner.authHeaders
            );
            spaceId = createRes.data.spaceId;
        });

        test("should fail when non-creator attempts to delete space", async () => {
            const res = await api.delete(`/api/v1/space/${spaceId}`, otherUser.authHeaders);

            expect(res.status).toBe(400);
            expect(res.data.msg).toBe("Unauthroized access !");
        });

        test("should successfully allow creator to delete space", async () => {
            const res = await api.delete(`/api/v1/space/${spaceId}`, owner.authHeaders);

            expect(res.status).toBe(200);
            expect(res.data.msg).toBe("Space Delted successfully !");

            // Verify space is no longer accessible
            const getRes = await api.get(`/api/v1/space/${spaceId}`, owner.authHeaders);
            expect(getRes.status).toBe(400);
            expect(getRes.data.msg).toBe("Space is not found !");
        });

        test("should fail when trying to delete non-existent space", async () => {
            const res = await api.delete("/api/v1/space/non_existent_space_id_999", owner.authHeaders);

            expect(res.status).toBe(400);
            expect(res.data.msg).toBe("Space not exits!");
        });

        test("should fail on double deletion of space", async () => {
            const res1 = await api.delete(`/api/v1/space/${spaceId}`, owner.authHeaders);
            expect(res1.status).toBe(200);

            const res2 = await api.delete(`/api/v1/space/${spaceId}`, owner.authHeaders);
            expect(res2.status).toBe(400);
            expect(res2.data.msg).toBe("Space not exits!");
        });

        test("should fail without auth token", async () => {
            const res = await api.delete(`/api/v1/space/${spaceId}`);

            expect(res.status).toBe(400);
            expect(res.data.msg).toBe("token is not present");
        });
    });
});

// =========================================================================
// 6. Security, Token Tampering & Injection Edge Cases
// =========================================================================
describe("6. Security, Token Tampering & Injection Edge Cases", () => {
    let validUser;

    beforeAll(async () => {
        validUser = await signupAndSignin("user");
    });

    test("should reject request with tampered JWT signature", async () => {
        const parts = validUser.token.split(".");
        // Tamper with the payload or signature
        const tamperedToken = `${parts[0]}.${parts[1]}.tamperedSignature12345`;

        const res = await api.get("/api/v1/space/all", {
            headers: {
                Authorization: tamperedToken,
            },
        });

        expect(res.status).toBe(400);
    });

    test("should reject token signed with an invalid/different JWT secret or forged signature", async () => {
        const forgedToken = createDummyJWT({ id: validUser.userId });

        const res = await api.get("/api/v1/space/all", {
            headers: {
                Authorization: forgedToken,
            },
        });

        expect(res.status).toBe(400);
    });

    test("should safely handle SQL / NoSQL injection-like strings in username and password", async () => {
        const maliciousPayloads = [
            `' OR '1'='1`,
            `admin' --`,
            `{"$gt": ""}`,
            `<script>alert(1)</script>`,
            `DROP TABLE User;--`,
        ];

        for (const payload of maliciousPayloads) {
            const signupRes = await api.post("/api/v1/signup", {
                username: `user_${Date.now()}_${payload}`,
                password: "password123!",
                type: "user",
            });

            // Either succeeds as a sanitized literal string or fails gracefully without 500 error
            expect([200, 400]).toContain(signupRes.status);
            expect(signupRes.status).not.toBe(500);
        }
    });
});

// =========================================================================
// 7. Multi-Tenant Isolation & Access Control Extreme Tests
// =========================================================================
describe("7. Multi-Tenant Isolation & Access Control Extreme Tests", () => {
    let tenantA;
    let tenantB;
    let spaceA;
    let spaceB;
    let elementIdA;

    beforeAll(async () => {
        tenantA = await signupAndSignin("user");
        tenantB = await signupAndSignin("user");

        const elemRes = await api.post("/api/v1/admin/element", {
            width: 25,
            height: 25,
            imageUrl: "https://example.com/itemA.png",
            static: true,
        });
        elementIdA = elemRes.data.id;

        const spaceResA = await api.post(
            "/api/v1/space",
            { name: "Tenant A Private Space", dimensions: "100x100", mapId: "" },
            tenantA.authHeaders
        );
        spaceA = spaceResA.data.spaceId;

        const spaceResB = await api.post(
            "/api/v1/space",
            { name: "Tenant B Private Space", dimensions: "100x100", mapId: "" },
            tenantB.authHeaders
        );
        spaceB = spaceResB.data.spaceId;
    });

    test("Tenant B cannot add element to Tenant A's space", async () => {
        const res = await api.post(
            "/api/v1/space/element",
            {
                spaceId: spaceA,
                elementId: elementIdA,
                x: 10,
                y: 10,
            },
            tenantB.authHeaders
        );

        expect(res.status).toBe(400);
        expect(res.data.msg).toBe("Space not found!");
    });

    test("Tenant B cannot delete Tenant A's element in Tenant A's space", async () => {
        // Tenant A adds an element
        const addRes = await api.post(
            "/api/v1/space/element",
            {
                spaceId: spaceA,
                elementId: elementIdA,
                x: 10,
                y: 10,
            },
            tenantA.authHeaders
        );
        expect(addRes.status).toBe(200);
        const spaceElementId = addRes.data.spaceElement.id;

        // Tenant B tries to delete it
        const deleteRes = await api.delete("/api/v1/space/element", {
            ...tenantB.authHeaders,
            data: { id: spaceElementId },
        });

        expect(deleteRes.status).toBe(400);
        expect(deleteRes.data.msg).toBe("Unauthroized access!");

        // Verify element is still present for Tenant A to delete
        const cleanupRes = await api.delete("/api/v1/space/element", {
            ...tenantA.authHeaders,
            data: { id: spaceElementId },
        });
        expect(cleanupRes.status).toBe(200);
    });

    test("Tenant B cannot delete Tenant A's space", async () => {
        const res = await api.delete(`/api/v1/space/${spaceA}`, tenantB.authHeaders);

        expect(res.status).toBe(400);
        expect(res.data.msg).toBe("Unauthroized access !");
    });
});