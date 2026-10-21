# Use official Node.js LTS image
FROM node:22.23.4

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Copy .npmrc for private package authentication
COPY .npmrc ./

# Install all dependencies (including dev)
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the app port
EXPOSE 3000

# Use the local dev script (tsx watch)
CMD ["npm", "run", "local-docker"] 