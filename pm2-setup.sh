# Install PM2 globally if not already installed
# npm install -g pm2

# Start the application with PM2
pm2 start npm --name "web-api" -- start

# Other useful PM2 commands:
# pm2 list - List all running applications
# pm2 stop web-api - Stop the application
# pm2 restart web-api - Restart the application
# pm2 delete web-api - Remove the application from PM2
# pm2 logs web-api - View application logs
# pm2 monit - Monitor CPU/Memory usage

# To make PM2 start on system boot:
# pm2 startup
# pm2 save
