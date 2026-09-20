import { Router } from "express";
import type { Request,Response } from "express";
import { addElementSchema, CreateAcatarSchema, CreateElementSchema, CreateMapSchema, UPdateElmentSchema } from "../types/index.js";
import prisma from "@repo/db";
import { RequestWithID } from "../middlewares/auth.middleware.js";
import { parse } from "path";
import { processSchema } from "zod/v4/core";
const adminRouter = Router();



// Add admin middleware here so that only admin can allowed to change this 

//Create an Element
adminRouter.post("/element",async(req : RequestWithID,res : Response)=>{
    const parsedData = CreateElementSchema.safeParse(req.body);
    if(!parsedData.success) return res.status(400).json({message : "Zod Validation Failed!"});

    const element = await prisma.element.create({
        data : {
            width : parsedData.data.width,
            height : parsedData.data.height,
            imageUrl : parsedData.data.imageUrl,
            static : parsedData.data.static
        }
    })

    return res.status(200).json({
        msg : "Element Created Successfully !",
        id : element.id
    })
    
})


adminRouter.put("/element/:elementId",async(req : RequestWithID,res : Response)=>{
    const parsedData = UPdateElmentSchema.safeParse(req.body);
    if(!parsedData.success) return res.status(400).json({message : "Zod Validation Failed!"});
    const elementId = req.params.elementId as string;

    const updateElement = await prisma.element.update({
        where : {
            id : elementId
        },
        data : {
            imageUrl : parsedData.data.imageUrl
        }
    });

    return res.status(200).json({msg : "Element Updated Successfully !"})
})


//create a avatar 

adminRouter.post("/avatar",async(req : RequestWithID,res : Response)=>{
    const parsedData = CreateAcatarSchema.safeParse(req.body);
    if(!parsedData.success){
        return res.status(400).json({message : "Zod Validation Failed!"});
    }
    const avatar = await prisma.avatar.create({
        data : {
            imageUrl : parsedData.data.imageUrl,
            name : parsedData.data.name
        }
    });
    return res.status(200).json({
        msg : "Avatar Created successfully !",
        avatarId : avatar.id
    })
    
})

adminRouter.get("/map",async (req : Request,res : Response)=>{
    const parsedData = CreateMapSchema.safeParse(req.body);
    if(!parsedData.success){
        return res.status(400).json({message : "Zod Validation Failed!"});
    }
    const map = await prisma.map.create({
        data : {
            name : parsedData.data.name,
            width : Number(parsedData.data.dimension.split("x")[0]),
            height : Number(parsedData.data.dimension.split("x")[1]),
            thumbnail : parsedData.data.thumbnail,
            mapElements : {
                create : parsedData.data.defaultElements.map((el:any)=>{
                    return {
                        elementId : el.elementId,
                        x : el.x,
                        y : el.y
                    }
                })
            }
        }
    });
    return res.status(200).json({msg : "Map Created Successfully !",mapId : map.id })
})

export default adminRouter;