import { Router } from "express";

import type { Request,Response } from "express";
import prisma from "@repo/db";
import { boolean, number, safeParse, string } from "zod";
import { addElementSchema, CreateSpaceSchema, DeleteElementSchema } from "../types/index.js";
import { authMiddleware, RequestWithID } from "../middlewares/auth.middleware.js";
const spaceRouter = Router();


//create space
spaceRouter.post("/",authMiddleware,async(req : RequestWithID ,res : Response)=>{
    const parsedData = CreateSpaceSchema.safeParse(req.body);
    if(!parsedData.success) return res.status(400).json({message : "Zod Validation Failed!"});

    //This will create the new space with 0(zero) Space Element
    if(!parsedData.data.mapId){
        const space = await prisma.space.create({
            data : {
                name : parsedData.data.name,
                width : Number(parsedData.data.dimensions.split("x")[0]),
                height : Number(parsedData.data.dimensions.split("x")[1]),
                createrId : req.userId!
            }
        })
        return res.status(200).json({message : "Space Created Successfully!",spaceId : space.id });
    }

    // if we want to create space with the exitsing map we have to copy all the map elements from that map
    const map = await prisma.map.findUnique({
        where : {
            id : parsedData.data.mapId
        },
        select : {
            id : true,
            height : true,
            width : true,
            name : true,
            mapElements : true
        }
    })
    if(!map) return res.status(400).json({message : "Map Not Found!"});

    
    let spaceId = await prisma.$transaction( async ()=>{

        // This will create a space with empty space element
        const space = await prisma.space.create({
            data : {
                name : parsedData.data.name,
                width : map.width,
                height : map.height,
                createrId : req.userId!,
            }
        });
        
        const spaceElement = await prisma.spaceElements.createMany({
            data : map.mapElements.map((element)=>({
                spaceId : space.id,
                elementId : element.elementId,
                x : element.x,
                y : element.y
            }))
        }); 
        return space.id;
    })

    return res.status(200).json({message : "Space Created Successfully!",spaceId});
})


// Only the creater can add the element in the space
spaceRouter.post("/element",authMiddleware,async(req : RequestWithID,res : Response)=>{
    const parsedData = addElementSchema.safeParse(req.body);
    if(!parsedData.success){
        return res.status(400).json({
            msg : "Invalid Data!",
            error : parsedData.error.issues
        })
    }
    const space = await prisma.space.findUnique({
        where : {
            id : parsedData.data.spaceId,
            createrId : req.userId
        }
    });
    
    if(!space){
        return res.status(400).json({msg : "Space not found!"});
    }
    
    const spaceElement = await prisma.spaceElements.create({
        data : {
            elementId : parsedData.data.elementId,
            spaceId : parsedData.data.spaceId,
            x : parsedData.data.x,
            y : parsedData.data.y
        }
    });
    
    return res.status(200).json({
        msg : "Element added successfully!",
        spaceElement 
    });
})


// Only creater can delete the element from the space 
spaceRouter.delete("/element",authMiddleware,async (req : RequestWithID,res : Response)=>{
    const parsedData = DeleteElementSchema.safeParse(req.body);
    if(!parsedData.success){
        return res.status(400).json({
            msg : "Invalid Data!",
            error : parsedData.error.issues
        })
    }
    const spaceElement = await prisma.spaceElements.findUnique({
        where : {
            id : parsedData.data.id as string
        },select : {
            space : true
        }
    });
    if(!spaceElement){
        return res.status(400).json({
            msg : "Element not found!"
        })
    }
    if(spaceElement.space.createrId != req.userId){
        return res.status(400).json({
            msg : "Unauthroized access!",
        })
    }
    
    const deleteSpaceElement = await prisma.spaceElements.delete({
        where : {
            id : parsedData.data.id as string
        }
    })

    return res.status(200).json({
        msg : "Element deleted successfully!",
        deleteSpaceElement
    })
})

// get all your space
spaceRouter.get("/all",authMiddleware,async (req : RequestWithID,res : Response)=>{
    const userId = req.userId;
    const space = await prisma.space.findMany({
        where : {
            createrId : userId
        },
        select : {
            id : true,
            name : true,
            height : true,
            width : true,
            thumbnail : true
        }
    });

    return res.status(200).json({
        msg : "Successfully !",
        space
    });

})

//delete space
spaceRouter.delete("/:spaceId",authMiddleware,async (req : RequestWithID,res : Response)=>{
    console.log(typeof(req.params.spaceId));
    const userId = req.userId;
    const space = await prisma.space.findUnique({
        where : {
            id : req.params.spaceId as string,
        },
        select : {
            createrId : true
        }
    });
    if(!space) return res.status(400).json({msg : "Space not exits!"});
    
    if(space.createrId != req.userId){
        return res.status(400).json({
            msg : "Unauthroized access !"
        })
    }
    const deletespace = await prisma.space.delete({
        where : {
            id : req.params.spaceId as string
        }
    });
    return res.status(200).json({msg : "Space Delted successfully !"});
})

// get a space with all its elements 
spaceRouter.get("/:spaceId", authMiddleware, async (req: RequestWithID, res: Response) => {
    const spaceId = req.params.spaceId as string;
    try {
        const space = await prisma.space.findUnique({
            where: {
                id: spaceId
            },
            select: {
                id: true,
                name: true,
                height: true,
                width: true,
                spaceElements: {
                    include: {
                        element: true
                    }
                }
            }
        });

        if (!space) {
            return res.status(404).json({
                msg: "Space is not found !"
            });
        }

        const elements = space.spaceElements.map((e, index) => ({
            id: index,
            x: e.x,
            y: e.y,
            element: {
                id: e.element.id,
                imageUrl: e.element.imageUrl,
                static: e.element.static,
                height: e.element.height,
                width: e.element.width
            }
        }));

        return res.status(200).json({
            id: space.id,
            name: space.name,
            height: space.height,
            width: space.width,
            elements
        });
    } catch (error) {
        return res.status(500).json({ msg: "Failed to fetch space", error });
    }
});


export default spaceRouter;
