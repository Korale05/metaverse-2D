import type { NextFunction, Request, Response } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";

export interface RequestWithID extends Request {
    userId?: string;
}

export async function authMiddleware(req: RequestWithID, res: Response, nex: NextFunction) {
    try {
        let token = req.cookies?.["accessToken"] || req.headers["authorization"] || req.headers["Authorization"];

        if (!token) {
            return res.status(401).json({
                msg: "Token is not present"
            });
        }

        if (typeof token === "string" && token.startsWith("Bearer ")) {
            token = token.split(" ")[1];
        }

        const JWT_PASSWORD = process.env.JWT_PASSWORD || "IloveOnkar";
        const decodeToken = jwt.verify(token as string, JWT_PASSWORD) as JwtPayload;
        if (!decodeToken) {
            return res.status(401).json({ msg: "Unauthorized access!" });
        }
        req.userId = decodeToken.userId || decodeToken.id;
        return nex();
    } catch (error) {
        console.log(error);
        return res.status(401).json({
            msg: "Invalid or expired token"
        });
    }
}
