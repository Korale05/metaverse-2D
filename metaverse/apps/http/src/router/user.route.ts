import { Router } from "express";
import { metadataBulk, updateMetadata } from "../controller/user.controller.js";
import type{ Request, Response } from "express";
import { updateMetadataSchema } from "../types/index.js";
import prisma from "@repo/db";
import { authMiddleware, RequestWithID } from "../middlewares/auth.middleware.js";
const userRouter = Router();


userRouter.post("/metadata",authMiddleware,async(req : RequestWithID,res : Response)=>{
    const parsedData = updateMetadataSchema.safeParse(req.body);
    if(!parsedData.success) return res.status(400).json({message : "Zod Validation Failed!"});

    try{
        const user = await prisma.user.update({
            where : {
                id : req.userId
            },
            data : {
                avatarId : parsedData.data.avatarId,
            }
        });
        return res.status(200).json({
            msg : "Successfully updated the metadata",
            avatarId : user.avatarId
        })
    }catch(error){
        return res.status(400).json({
            msg : "somethign went Wrong ",
            error : error
        })
    }

});
userRouter.get("/metadata/bulk",async(req : Request,res : Response)=>{
    const userId = JSON.parse(req.query.ids as string);
    const users = await prisma.user.findMany({
        where : {
            id : {in : userId}
        }
    });
    return res.status(200).json({
        userMetaData : users.map(user => {
            return {
                userId : user.id,
                username : user.username,
                avatarId : user.avatarId,
            }
        })
    })
    
});


export default userRouter;