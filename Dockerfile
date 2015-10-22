# Depend on ubuntu 12.04
FROM    ubuntu:12.04
MAINTAINER Simon Gaeremynck "gaeremyncks@gmail.com"

# install wget and git
RUN apt-get -y -q install curl wget git-core python-software-properties

# Add a few apt repositories
RUN curl -L http://debian.datastax.com/debian/repo_key | apt-key add -
RUN echo "deb http://debian.datastax.com/community stable main" | tee -a /etc/apt/sources.list.d/dsc.sources.list
RUN wget -qO - http://packages.elasticsearch.org/GPG-KEY-elasticsearch | apt-key add -
RUN echo "deb http://packages.elasticsearch.org/elasticsearch/1.5/debian stable main" | tee -a /etc/apt/sources.list.d/elasticsearch.sources.list
RUN add-apt-repository ppa:oae/deps -y
RUN add-apt-repository ppa:webupd8team/java -y
RUN apt-get update

# Install oracle Java 7
RUN echo oracle-java7-installer shared/accepted-oracle-license-v1-1 select true | /usr/bin/debconf-set-selections
RUN apt-get install -y oracle-java7-installer

# Install Cassandra
RUN apt-get install -y -o Dpkg::Options::=--force-confnew cassandra=2.0.8
RUN sed -i 's/ulimit -l unlimited/#ulimit -l unlimited/g' /etc/init.d/cassandra
RUN service cassandra start

# Install elastic search
RUN apt-get install -y --force-yes -o Dpkg::Options::=--force-confnew elasticsearch=1.5.2
RUN service elasticsearch start

# Install redis
RUN apt-get install -y redis-server

# Install rabbitmq
RUN apt-get install -y rabbitmq-server

# Install other dependencies
RUN apt-get install -qq graphicsmagick libreoffice chrpath pdf2htmlex poppler-utils

# verify gpg and sha256: http://nodejs.org/dist/v0.10.31/SHASUMS256.txt.asc
# gpg: aka "Timothy J Fontaine (Work) <tj.fontaine@joyent.com>"
# gpg: aka "Julien Gilli <jgilli@fastmail.fm>"
RUN set -ex \
    && for key in \
        7937DFD2AB06298B2293C3187D33FF9D0246406D \
        114F43EE0176B71C7BC219DD50A3051F888C628D \
    ; do \
        gpg --keyserver ha.pool.sks-keyservers.net --recv-keys "$key"; \
    done

ENV NODE_VERSION 0.10.40
ENV NPM_VERSION 2.14.1

RUN curl -SLO "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.gz" \
    && curl -SLO "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt.asc" \
    && gpg --verify SHASUMS256.txt.asc \
    && grep " node-v$NODE_VERSION-linux-x64.tar.gz\$" SHASUMS256.txt.asc | sha256sum -c - \
    && tar -xzf "node-v$NODE_VERSION-linux-x64.tar.gz" -C /usr/local --strip-components=1 \
    && rm "node-v$NODE_VERSION-linux-x64.tar.gz" SHASUMS256.txt.asc \
    && npm install -g npm@"$NPM_VERSION" \
    && npm cache clear

# Clean up downloaded files to keep the docker image size small
RUN apt-get clean
