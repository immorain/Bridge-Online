# Use a small Node base image
FROM node:18-alpine

# Create app directory
WORKDIR /app

# Install production dependencies first
COPY package*.json ./
RUN npm install --production

# Copy the rest of the app
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node","server.js"]
