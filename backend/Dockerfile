FROM alpine:3.22 AS terrain
RUN apk add --no-cache build-base git nodejs
WORKDIR /src
COPY terrain/native ./terrain/native
COPY terrain/sources.json ./terrain/sources.json
COPY scripts/build-terrain-engine.mjs ./scripts/build-terrain-engine.mjs
RUN node scripts/build-terrain-engine.mjs

FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY backend/pom.xml .
RUN mvn -B -ntp dependency:go-offline
COPY backend/src ./src
RUN mvn -B -ntp package -DskipTests

FROM eclipse-temurin:21-jdk-alpine AS scene
RUN apk add --no-cache python3 git
WORKDIR /src
COPY scene ./scene
RUN python3 scene/build.py --output /scene-runtime --sources /scene-sources

FROM eclipse-temurin:21-jre-alpine
RUN apk add --no-cache nodejs npm openjdk21-jre xvfb-run xauth libxtst libxi libxrender font-dejavu && node --input-type=module -e "if(Number(process.versions.node.split('.')[0])<22)process.exit(1)" \
    && addgroup -S mcmanager && adduser -S -G mcmanager mcmanager
WORKDIR /app
COPY --from=build /src/target/mcmanager-archive-0.1.0.jar app.jar
COPY --from=terrain /src/terrain/bin /app/terrain
COPY --from=scene /scene-runtime /app/scene
COPY backup/package.json backup/package-lock.json /app/backup/
RUN cd /app/backup && npm ci --ignore-scripts --omit=dev && mkdir -p /app/data/backups && chown -R mcmanager:mcmanager /app/data
COPY backup/src /app/backup/src
USER mcmanager
ENV MCM_BIND_ADDRESS=0.0.0.0
ENV MCM_TERRAIN_ENGINE=/app/terrain/mcarchive-terrain
ENV MCM_BACKUP_VERIFIER=/app/backup/src/verify-upload.mjs
ENV MCM_BACKUP_DIR=/app/data/backups
ENV MCM_SCENE_RUNNER=/app/scene/run.mjs
ENV MCM_SCENE_JAVA=/usr/lib/jvm/java-21-openjdk/bin/java
ENV MCM_SCENE_DIR=/app/data/backups/scenes
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
