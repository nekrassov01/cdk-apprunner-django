#!/bin/bash
python /django/manage.py migrate
python /django/manage.py createsuperuser --noinput
python /django/manage.py runserver 0.0.0.0:8080
