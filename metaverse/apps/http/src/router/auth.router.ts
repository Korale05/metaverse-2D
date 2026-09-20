
import type { Request , Response } from "express";
import { Router } from "express";
import { SignupSchema, SignInSchema } from "../types/index.js";
import prisma from "@repo/db";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

const authRouter = Router();

dotenv.config();

async function hashPassword(password : string){
    return await bcrypt.hash(password,10);
}

function generateAccessToken(id : string){
    const JWT_PASSWORD = process.env.JWT_PASSWORD || "IloveOnkar";
    return jwt.sign({
            id,
            userId : id
        },JWT_PASSWORD,
        {
            expiresIn : "15m"
        }
    );
}
function generateRefreshToken(id : string){
    const JWT_PASSWORD = process.env.JWT_PASSWORD || "IloveOnkar";
    return jwt.sign({
            id,
            userId : id
        },JWT_PASSWORD,{
            expiresIn : "7d"
        }
    );
}
async function verifyAccessToken(token : string){
    const JWT_PASSWORD = process.env.JWT_PASSWORD || "IloveOnkar";
    return jwt.verify(token,JWT_PASSWORD);
}
async function verifyRefreshToken(token : string){
    const JWT_PASSWORD = process.env.JWT_PASSWORD || "IloveOnkar";
    return jwt.verify(token,JWT_PASSWORD);
}
authRouter.post("/signup", async (req: Request, res: Response) => {
    const parsedData = SignupSchema.safeParse(req.body);
    if (!parsedData.success) return res.status(400).json({ message: "Zod Validation failed!", error: parsedData.error });

    // try if user already exits or not 
    try {
        const existingUser = await prisma.user.findUnique({
            where: {
                username: parsedData.data.username
            },
            select: {
                id: true
            }
        });

        if (existingUser) return res.status(400).json({ message: "Username already exists" });

        //if not
        const hashedPassword = await hashPassword(parsedData.data.password);
        const user = await prisma.user.create({
            data: {
                username: parsedData.data.username,
                password: hashedPassword,
                role: parsedData.data.type === "admin" ? "Admin" : "User",
            }
        });

        const accessToken = generateAccessToken(user.id);
        const refreshToken = generateRefreshToken(user.id);

        const cookieOptions = {
            path: "/",
            httpOnly: false,
            sameSite: "lax" as const,
        };

        res.cookie("accessToken", accessToken, cookieOptions);
        res.cookie("refreshToken", refreshToken, cookieOptions);

        return res.status(200).json({
            msg: "Successfully signed up",
            userId: user.id,
            username: user.username,
            token: accessToken,
            accessToken: accessToken,
            refreshToken: refreshToken
        });

    } catch (error: any) {
        console.error("Signup error:", error);
        if (error.code === "P2002") {
            return res.status(400).json({ message: "Username already exists" });
        }
        return res.status(400).json({ message: "Something went wrong", error: error.message || error });
    }
});

authRouter.post("/signin", async (req: Request, res: Response) => {
    const parsedData = SignInSchema.safeParse(req.body);
    if (!parsedData.success) return res.status(400).json({ message: "Zod Validation failed!" });

    try {
        const user = await prisma.user.findUnique({
            where: {
                username: parsedData.data.username
            }
        });
        if (!user) {
            return res.status(400).json({ msg: "User not found, please SignUp first" });
        }
        const isValid = await bcrypt.compare(parsedData.data.password, user.password);
        if (!isValid) {
            return res.status(400).json({ msg: "Password is incorrect" });
        }

        const accessToken = generateAccessToken(user.id);
        const refreshToken = generateRefreshToken(user.id);

        const cookieOptions = {
            path: "/",
            httpOnly: false,
            sameSite: "lax" as const,
        };

        res.cookie("accessToken", accessToken, cookieOptions);
        res.cookie("refreshToken", refreshToken, cookieOptions);

        await prisma.user.update({
            where: {
                id: user.id
            },
            data: {
                refreshToken: refreshToken,
            }
        });

        return res.json({
            msg: "Successfully signed in",
            userId: user.id,
            username: user.username,
            token: accessToken,
            accessToken: accessToken,
            refreshToken: refreshToken
        });

    } catch (error: any) {
        return res.status(400).json({ message: "Something went wrong: " + (error.message || error) });
    }
});





export default authRouter;