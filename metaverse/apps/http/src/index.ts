import "dotenv/config";
import express from "express";
import cors from "cors";
import router from "./router/router.js";
import userRouter from "./router/user.route.js";
import adminRouter from "./router/admin.route.js";
import spaceRouter from "./router/space.route.js";
import prisma from "@repo/db";
import cookieParser from "cookie-parser";
import { Request, Response } from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
    origin: [
        "http://localhost:5173",
        "http://localhost:8080"
        
        // Add Production FrontEnd  url also here
        
    ],
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());
app.use("/api/v1/user", userRouter);
app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/space", spaceRouter);
app.use("/api/v1", router);

app.get("/", (req: Request, res: Response) => {
    return res.send("Hello Folks!");
});

app.listen(PORT, () => {
    console.log(`App is listening on PORT : ${PORT}`);
});
