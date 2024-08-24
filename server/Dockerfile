# Use an official Node.js runtime as the base image
FROM node:18

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install the application dependencies
RUN npm install

# Copy the server code to the container
COPY server.js .

# Create a volume for persistent storage
VOLUME /usr/src/app/data

# Expose the port the app runs on
EXPOSE 3000

# Command to run the application
CMD ["node", "server.js"]