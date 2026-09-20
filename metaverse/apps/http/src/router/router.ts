import { Router } from "express";
import authRouter from "./auth.router.js";

import type { Request, Response } from "express";
import prisma from "@repo/db";
// api/v1/..
const router = Router();


// get all available avatars information 

router.get("/avatars",async(req : Request,res : Response)=>{
    const avatar = await prisma.avatar.findMany()
    return res.status(200).json({avatar})
})


// get all available element information 
router.get("/elements",async(req : Request,res : Response)=>{
    const element = await prisma.element.findMany()
    return res.status(200).json({element})  
})


router.use("/",authRouter);




export default router;