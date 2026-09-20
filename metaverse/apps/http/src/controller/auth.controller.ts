import type { Request,Response } from "express"


function signup(req : Request,res : Response){
    return res.json({
        message : "Signup"
    })
}

function signin(req : Request,res : Response){
    return res.json({
        message : "Signin"
    })
}

export { signin ,signup };