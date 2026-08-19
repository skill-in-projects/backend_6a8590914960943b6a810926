const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const winston = require('winston');
const testController = require('./Controllers/TestController');

// Configure logging - Warning and Error only
const logger = winston.createLogger({
  level: 'warn',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Swagger configuration
const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Backend API',
            version: '1.0.0',
            description: 'Backend API documentation'
        },
        servers: [
            {
                url: '/',
                description: 'Current server'
            }
        ]
    },
    apis: ['./Controllers/*.js']
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/swagger', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec)); // Also support /docs like FastAPI

// Async wrapper to catch errors from async route handlers and pass them to error handler
const asyncHandler = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};

// Google API proxy routes (status, gemini, geocoding, maps, directions, places, speech-to-text)
const googleApiController = require('./Controllers/GoogleApiController');
app.use('/api/google', googleApiController);

// Routes - wrap async handlers to catch errors
app.get('/api/test', asyncHandler(testController.getAll));
app.get('/api/test/:id', asyncHandler(testController.getById));
app.post('/api/test', asyncHandler(testController.create));
app.put('/api/test/:id', asyncHandler(testController.update));
app.delete('/api/test/:id', asyncHandler(testController.remove));

app.get('/', (req, res) => {
    res.json({ 
        message: 'Backend API is running',
        status: 'ok',
        swagger: '/swagger',
        api: '/api/test'
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        service: 'Backend API'
    });
});

// Global error handler middleware - MUST be registered AFTER all routes
// This catches all unhandled errors and sends them to the runtime error endpoint
app.use((err, req, res, next) => {
    logger.error('[ERROR HANDLER] Unhandled error occurred:', err);
    
    // Extract boardId from request
    const boardId = extractBoardId(req);
    logger.warn(`[ERROR HANDLER] Extracted boardId: ${boardId || 'NULL'}`);
    
    // Send error to runtime error endpoint if configured
    const runtimeErrorEndpointUrl = process.env.RUNTIME_ERROR_ENDPOINT_URL;
    if (runtimeErrorEndpointUrl) {
        logger.warn(`[ERROR HANDLER] Sending error to endpoint: ${runtimeErrorEndpointUrl}`);
        sendErrorToEndpoint(runtimeErrorEndpointUrl, boardId, req, err).catch(err => {
            logger.error('[ERROR HANDLER] Failed to send error to endpoint:', err);
        });
    } else {
        logger.warn('[ERROR HANDLER] RUNTIME_ERROR_ENDPOINT_URL is not set - skipping error reporting');
    }
    
    // Return error response to client
    res.status(err.status || 500).json({
        error: 'An error occurred while processing your request',
        message: err.message || 'Unknown error'
    });
});

function extractBoardId(req) {
    // Try route parameters
    if (req.params && req.params.boardId) {
        return req.params.boardId;
    }
    
    // Try query parameters
    if (req.query && req.query.boardId) {
        return req.query.boardId;
    }
    
    // Try headers
    if (req.headers['x-board-id']) {
        return req.headers['x-board-id'];
    }
    
    // Try environment variable
    const boardIdEnv = process.env.BOARD_ID;
    if (boardIdEnv) {
        return boardIdEnv;
    }
    
    // Try to extract from hostname (Railway pattern: webapi{boardId}.up.railway.app - no hyphen)
    const host = req.get('host') || req.headers.host || '';
    const hostMatch = host.match(/webapi([a-f0-9]{24})/i);
    if (hostMatch) {
        return hostMatch[1];
    }
    
    // Try to extract from RUNTIME_ERROR_ENDPOINT_URL if it contains boardId pattern
    const endpointUrl = process.env.RUNTIME_ERROR_ENDPOINT_URL || '';
    const urlMatch = endpointUrl.match(/webapi([a-f0-9]{24})/i);
    if (urlMatch) {
        return urlMatch[1];
    }
    
    return null;
}

async function sendErrorToEndpoint(endpointUrl, boardId, req, error) {
    try {
        const http = require('http');
        const https = require('https');
        const { URL } = require('url');
        const url = new URL(endpointUrl);
        const client = url.protocol === 'https:' ? https : http;
        
        // Get stack trace
        const stack = error.stack || 'N/A';
        
        // Get file and line from stack
        // Node.js stack format: "Error: message\n    at functionName (file:line:column)\n    at ..."
        const stackLines = stack.split('\\n');
        let fileName = null;
        let lineNumber = null;
        
        // Look for the first stack line that contains a file path (skip error message line)
        for (let i = 1; i < stackLines.length; i++) {
            const line = stackLines[i].trim();
            
            // Match pattern: "at functionName (file:line:column)"
            // Example: "at getAll (/app/Controllers/TestController.js:43:11)"
            // Find the last occurrence of :digits:digits) pattern to extract file:line:column
            const parenIndex = line.indexOf('(');
            const parenCloseIndex = line.indexOf(')', parenIndex);
            if (parenIndex >= 0 && parenCloseIndex > parenIndex) {
                const content = line.substring(parenIndex + 1, parenCloseIndex);
                // Match :digits:digits at the end
                const match = content.match(/(.+):(\\d+):(\\d+)$/);
                if (match && match[1] && match[2]) {
                    const filePath = match[1].trim();
                    // Extract just the filename
                    const lastSlash = filePath.lastIndexOf('/');
                    fileName = lastSlash >= 0 ? filePath.substring(lastSlash + 1) : filePath;
                    lineNumber = parseInt(match[2], 10);
                    if (fileName && !isNaN(lineNumber)) {
                        break;
                    }
                }
            }
            
            // Match pattern: "at file:line:column" (no function name, no parentheses)
            // Example: "at /app/app.js:57:25"
            if (!fileName || isNaN(lineNumber)) {
                // Find pattern: at followed by file:line:column
                const atIndex = line.indexOf('at ');
                if (atIndex >= 0) {
                    const afterAt = line.substring(atIndex + 3).trim();
                    const match = afterAt.match(/^([^\\s]+):(\\d+):(\\d+)/);
                    if (match && match[1] && match[2]) {
                        const filePath = match[1].trim();
                        // Extract just the filename
                        const lastSlash = filePath.lastIndexOf('/');
                        fileName = lastSlash >= 0 ? filePath.substring(lastSlash + 1) : filePath;
                        lineNumber = parseInt(match[2], 10);
                        if (fileName && !isNaN(lineNumber)) {
                            break;
                        }
                    }
                }
            }
        }
        
        // Debug logging
        if (!fileName || isNaN(lineNumber)) {
            logger.warn(`[ERROR HANDLER] Failed to extract file/line from stack. Stack lines: ${stackLines.length}, First few lines: ${stackLines.slice(0, 3).join(' | ')}`);
        }
        
        const payload = JSON.stringify({
            boardId: boardId,
            timestamp: new Date().toISOString(),
            file: fileName,
            line: lineNumber,
            stackTrace: stack,
            message: error.message || 'Unknown error',
            exceptionType: error.name || 'Error',
            requestPath: req.path || req.url,
            requestMethod: req.method,
            userAgent: req.get('user-agent')
        });
        
        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 5000
        };
        
        return new Promise((resolve, reject) => {
            const req = client.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    logger.warn(`[ERROR HANDLER] Error endpoint response: ${res.statusCode} - ${data}`);
                    resolve();
                });
            });
            
            req.on('error', (err) => {
                logger.error('[ERROR HANDLER] Request error:', err);
                reject(err);
            });
            
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            
            req.write(payload);
            req.end();
        });
    } catch (err) {
        logger.error('[ERROR HANDLER] Error in sendErrorToEndpoint:', err);
        throw err;
    }
}

app.listen(PORT, '0.0.0.0', (err) => {
    if (err) {
        logger.error(`[STARTUP ERROR] Failed to start server: ${err.message}`);
        
        // Send startup error to endpoint (fire and forget)
        const runtimeErrorEndpointUrl = process.env.RUNTIME_ERROR_ENDPOINT_URL;
        const boardId = process.env.BOARD_ID;
        
        if (runtimeErrorEndpointUrl) {
            const payload = JSON.stringify({
                boardId: boardId,
                timestamp: new Date().toISOString(),
                file: err.stack ? err.stack.split('\\n')[0] : null,
                line: null,
                stackTrace: err.stack || 'N/A',
                message: err.message || 'Unknown error',
                exceptionType: err.name || 'Error',
                requestPath: 'STARTUP',
                requestMethod: 'STARTUP',
                userAgent: 'STARTUP_ERROR'
            });
            
            const http = require('http');
            const https = require('https');
            const { URL } = require('url');
            const url = new URL(runtimeErrorEndpointUrl);
            const client = url.protocol === 'https:' ? https : http;
            
            const options = {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                },
                timeout: 5000
            };
            
            const req = client.request(options, () => {});
            req.on('error', () => {});
            req.write(payload);
            req.end();
        }
        
        process.exit(1);
    } else {
        logger.warn(`Server is running on 0.0.0.0:${PORT}`);
    }
});
