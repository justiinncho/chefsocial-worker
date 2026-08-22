FROM node:20-bookworm-slim

# ffmpeg does the cutting; fontconfig + the kit fonts do the on-screen text.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fontconfig ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*

ENV FONT_DIR=/usr/share/fonts/truetype/chefsocial
RUN mkdir -p $FONT_DIR \
  && for f in \
    "PlayfairDisplay-Bold.ttf:playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf" \
    "BebasNeue-Regular.ttf:bebasneue/BebasNeue-Regular.ttf" \
    "Caveat-Bold.ttf:caveat/Caveat%5Bwght%5D.ttf" \
    "PlusJakartaSans-ExtraBold.ttf:plusjakartasans/PlusJakartaSans%5Bwght%5D.ttf" \
  ; do \
    name="${f%%:*}"; src="${f#*:}"; \
    curl -fsSL "https://github.com/google/fonts/raw/main/ofl/$src" -o "$FONT_DIR/$name"; \
  done \
  && fc-cache -f

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.mjs ./

CMD ["node", "index.mjs"]
