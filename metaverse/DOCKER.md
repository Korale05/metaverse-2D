# HOW TO RUN DOCKER APPLICATION 

## FRONT END
    docker run -p 5173:80 metaverse-frontend

## BACKEND 
    docker run -p 3000:3000 `
-e JWT_PASSWORD="IloveOnkar" `
-e DATABASE_URL="postgresql://postgres:postgres@host.docker.internal:5433/postgres" `
metaverses-backend

# -e that give set the environment variable inside the docker container so we have 2 environment password

## WS
    docker run -p 8080:8080 `
-e JWT_PASSWORD="IloveOnkar" `
-e DATABASE_URL="postgresql://postgres:postgres@host.docker.internal:5433/postgres" `
metaverse-ws


## Backend Without - means 