# Imagen base oficial de Node.js ligera
FROM node:20-alpine

# Crear directorio de la aplicación
WORKDIR /usr/src/app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias de producción (evita instalar dependencias de desarrollo inútiles)
RUN npm install --only=production

# Copiar todo el código del proyecto al contenedor
COPY . .

# Exponer el puerto de red
EXPOSE 6000

# Variable de entorno por defecto para producción
ENV PORT=6000
ENV NODE_ENV=production
# Directorio persistente para la base de datos SQLite en la nube
ENV PERSISTENT_DIR=/usr/src/app/data

# Crear carpeta de base de datos para evitar problemas de permisos
RUN mkdir -p /usr/src/app/data

# Comando de arranque del servidor
CMD ["npm", "start"]
