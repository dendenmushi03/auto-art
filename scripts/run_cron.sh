#!/bin/bash
curl -X POST "https://YOUR-APP.onrender.com/cron/run" \
  -H "x-cron-key: YOUR_CRON_SECRET"
