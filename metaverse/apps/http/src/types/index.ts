import z from "zod";



export const SignupSchema = z.object({
    username : z.string(),
    password : z.string().min(6),
    type : z.enum(["user","admin"]),
});

export const SignInSchema = z.object({
    username : z.string(),
    password : z.string().min(6)
})

export const updateMetadataSchema = z.object({
    avatarId : z.string()
});


export const CreateSpaceSchema = z.object({
    name : z.string(),
    dimensions : z.string(),
    mapId : z.string().optional()
})

export const addElementSchema = z.object({
    spaceId : z.string(),
    elementId : z.string(),
    x : z.number(),
    y : z.number()
});

export const DeleteElementSchema = z.object({
    id : z.string()
});

export const CreateElementSchema = z.object({
    imageUrl : z.string(),
    width : z.number(),
    height : z.number(),
    static : z.boolean()
})


export const UPdateElmentSchema = z.object({
    imageUrl : z.string()
})

export const CreateAcatarSchema = z.object({
    name : z.string(),
    imageUrl : z.string()
})

export const CreateMapSchema = z.object({
    thumbnail : z.string(),
    dimension : z.string(),
    name : z.string(),
    defaultElements : z.array(z.object({
        elementId : z.string(),
        x : z.number(),
        y : z.number()
    }))
})