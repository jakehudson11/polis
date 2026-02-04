FROM docker.io/clojure:temurin-17-tools-deps

WORKDIR /app
COPY . .

RUN apt-get update \
  && apt-get install -y --no-install-recommends coreutils \
  && rm -rf /var/lib/apt/lists/*

RUN curl -L -o /app/dd-java-agent.jar 'https://dtdg.co/latest-java-tracer'

# Install clojure and fetch dependencies
RUN clojure -A:dev -P

RUN sed -i 's/\r$//' ./bin/run \
  && chmod +x ./bin/run
CMD ["sh", "./bin/run"]
