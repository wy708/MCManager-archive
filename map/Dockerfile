FROM python:3.11-slim
ARG MIPMAP_REVISION=c30998792eba2d25ee9fa86b40594629bbf28c34
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && git init /upstream && cd /upstream \
    && git remote add origin https://github.com/MipaSenpai/MipMap.git \
    && git fetch --depth 1 origin ${MIPMAP_REVISION} && git checkout --detach FETCH_HEAD \
    && cp LICENSE /MIPMAP-LICENSE && cp -a webmap /app && rm -rf /upstream \
    && apt-get purge -y git && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN pip install --no-cache-dir -r requirements.txt
# Official Bedrock resources match the 1.26.50/1.26.51 game family.
ARG BEDROCK_RESOURCES_REVISION=46ba6ea985fb5a92d79a9419198f10dda14c199d
COPY build_materials.py /tmp/build_materials.py
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && git init /bedrock && cd /bedrock \
    && git remote add origin https://github.com/Mojang/bedrock-samples.git \
    && git fetch --depth 1 origin ${BEDROCK_RESOURCES_REVISION} && git checkout --detach FETCH_HEAD \
    && python /tmp/build_materials.py /bedrock /app/assets/bedrock \
    && cp LICENSE.md /BEDROCK-RESOURCES-LICENSE.md && rm -rf /bedrock \
    && apt-get purge -y git && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
# Preserve the original UI, height shading, collection policy and commands.
COPY patch_web.py /tmp/patch_web.py
COPY live_tiles.js /tmp/live_tiles.js
COPY layer_controls.js /tmp/layer_controls.js
COPY cave_layers.py /app/services/cave_layers.py
COPY map_compat.py /app/services/map_compat.py
COPY block_materials.py /app/services/block_materials.py
COPY surface_composite.py /app/services/surface_composite.py
COPY patch_layers.py /tmp/patch_layers.py
COPY map_coverage.py /app/services/map_coverage.py
COPY project_maps.py /app/services/project_maps.py
COPY patch_project_maps.py /tmp/patch_project_maps.py
COPY patch_initial_view.py /tmp/patch_initial_view.py
COPY patch_coordinate_jump.py coordinate_jump.js coordinate_jump.css viewer_language.js /tmp/
COPY audit_materials.py /app/audit_materials.py
RUN python /tmp/patch_web.py
RUN python /tmp/patch_layers.py
RUN python /tmp/patch_initial_view.py
RUN python /tmp/patch_coordinate_jump.py
RUN python /tmp/patch_project_maps.py
RUN python audit_materials.py
RUN useradd --uid 10001 --create-home mapper && chown -R mapper:mapper /app
USER mapper
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
