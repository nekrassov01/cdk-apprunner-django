FROM python:3.9.16

ENV PYTHONUNBUFFERED 1
ENV PYTHONIOENCODING utf-8
ENV DEBCONF_NOWARNINGS yes
ENV DEBIAN_FRONTEND noninteractive

ARG DIR=django
COPY ./ /$DIR/
WORKDIR /$DIR

RUN set -eux \
&& apt-get update -y -qq \
&& apt-get install -y -qq --no-install-recommends vim git curl tree \
&& apt-get clean -y \
&& rm -rf /var/lib/apt/lists/* \
&& pip install --no-cache-dir -r requirements.txt \
&& if [ ! -f manage.py ]; then django-admin startproject config .; fi

EXPOSE 8080
