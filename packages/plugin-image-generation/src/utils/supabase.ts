import { createClient } from '@supabase/supabase-js';
import { elizaLogger } from '@elizaos/core';
import * as fs from 'fs';

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase credentials in environment variables');
}

const supabase = createClient(supabaseUrl, supabaseKey);

interface GeneratedImageRecord {
    id: string;
    created_at: string;
    storage_path: string;
    original_filepath: string;
    prompt: string;
    status: string;
    error_message?: string;
    metadata?: Record<string, any>;
}

async function validateImage(filepath: string): Promise<boolean> {
    try {
        elizaLogger.log('Starting image validation for:', filepath);

        // Check if file exists
        if (!fs.existsSync(filepath)) {
            elizaLogger.error('Image file does not exist:', filepath);
            return false;
        }

        // Check file stats
        const stats = await fs.promises.stat(filepath);
        elizaLogger.log('Image file stats:', {
            size: `${(stats.size / 1024 / 1024).toFixed(2)}MB`,
            created: stats.birthtime,
            modified: stats.mtime
        });

        // Check if file is empty
        if (stats.size === 0) {
            elizaLogger.error('Image file is empty');
            return false;
        }

        // Check file size (5MB limit)
        if (stats.size > 5 * 1024 * 1024) {
            elizaLogger.error('Image file is too large:', `${(stats.size / 1024 / 1024).toFixed(2)}MB`);
            return false;
        }

        // Check file extension
        const ext = filepath.split('.').pop()?.toLowerCase();
        if (!ext || !['png', 'jpg', 'jpeg', 'gif'].includes(ext)) {
            elizaLogger.error('Invalid image file extension:', ext);
            return false;
        }

        // Try to read the first few bytes to verify it's a valid image
        const fd = await fs.promises.open(filepath, 'r');
        const buffer = Buffer.alloc(4);
        await fd.read(buffer, 0, 4, 0);
        await fd.close();

        // Check magic numbers for common image formats
        const isPNG = buffer.toString('hex').startsWith('89504e47');
        const isJPEG = buffer.toString('hex').startsWith('ffd8');
        const isGIF = buffer.toString('hex').startsWith('47494638');

        if (!isPNG && !isJPEG && !isGIF) {
            elizaLogger.error('File does not appear to be a valid image');
            return false;
        }

        elizaLogger.log('Image validation successful');
        return true;
    } catch (error) {
        elizaLogger.error('Image validation failed with error:', error);
        return false;
    }
}

async function retryOperation<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    delay: number = 1000
): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error as Error;
            if (attempt === maxRetries) break;

            elizaLogger.warn(`Operation failed, attempt ${attempt}/${maxRetries}. Retrying in ${delay}ms...`, error);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2; // Exponential backoff
        }
    }

    throw lastError;
}

export async function uploadGeneratedImage(
    filepath: string,
    prompt: string
): Promise<GeneratedImageRecord | null> {
    let recordId: string | null = null;
    let uploadStartTime = Date.now();

    try {
        elizaLogger.log('Starting image upload process for:', filepath);
        elizaLogger.log('Upload details:', {
            filepath,
            promptLength: prompt.length,
            startTime: new Date(uploadStartTime).toISOString()
        });

        // Validate image before upload
        const isValid = await validateImage(filepath);
        if (!isValid) {
            throw new Error('Image validation failed - check previous logs for details');
        }

        // Create database record with retries
        const { data: recordData, error: recordError } = await retryOperation(async () => {
            const result = await supabase
                .from('generated_images')
                .insert([
                    {
                        original_filepath: filepath,
                        prompt: prompt,
                        status: 'uploading',
                        storage_path: '',
                        metadata: {
                            uploadStarted: new Date().toISOString(),
                            originalFilename: filepath.split('/').pop(),
                            attempts: 1
                        }
                    }
                ])
                .select()
                .single();

            if (result.error) throw result.error;
            return result;
        });

        if (recordError) {
            throw new Error(`Failed to create database record: ${recordError.message}`);
        }

        recordId = recordData.id;
        elizaLogger.log('Created database record:', { recordId, status: 'uploading' });

        // Read and validate the image file
        const fileBuffer = await fs.promises.readFile(filepath);
        const filename = filepath.split('/').pop();

        if (!filename) {
            throw new Error('Invalid filepath - no filename found');
        }

        // Upload to Supabase Storage with retries
        const storagePath = `generated-images/${recordId}_${filename}`;
        elizaLogger.log('Attempting storage upload:', { storagePath, size: fileBuffer.length });

        const { data: storageData, error: storageError } = await retryOperation(async () => {
            const result = await supabase.storage
                .from('generated-images')
                .upload(storagePath, fileBuffer, {
                    contentType: 'image/png',
                    upsert: true
                });

            if (result.error) throw result.error;
            return result;
        });

        if (storageError) {
            throw new Error(`Storage upload failed: ${storageError.message}`);
        }

        // Get the public URL
        const { data: { publicUrl } } = supabase.storage
            .from('generated-images')
            .getPublicUrl(storagePath);

        elizaLogger.log('Storage upload successful:', { publicUrl });

        // Update the record with retries
        const { data: updatedRecord, error: updateError } = await retryOperation(async () => {
            const result = await supabase
                .from('generated_images')
                .update({
                    storage_path: publicUrl,
                    status: 'completed',
                    metadata: {
                        ...recordData.metadata,
                        uploadCompleted: new Date().toISOString(),
                        processingTime: Date.now() - uploadStartTime
                    }
                })
                .eq('id', recordId)
                .select()
                .single();

            if (result.error) throw result.error;
            return result;
        });

        if (updateError) {
            throw new Error(`Failed to update record: ${updateError.message}`);
        }

        const processingTime = Date.now() - uploadStartTime;
        elizaLogger.log('Upload process completed successfully:', {
            id: updatedRecord.id,
            url: publicUrl,
            processingTime: `${processingTime}ms`
        });

        return updatedRecord;

    } catch (error) {
        const failureTime = Date.now() - uploadStartTime;
        elizaLogger.error('Error in uploadGeneratedImage:', {
            error,
            processingTime: `${failureTime}ms`,
            filepath,
            recordId
        });

        // If we have a record ID, update it with the error
        if (recordId) {
            try {
                await retryOperation(async () => {
                    const result = await supabase
                        .from('generated_images')
                        .update({
                            status: 'error',
                            error_message: error instanceof Error ? error.message : 'Unknown error',
                            metadata: {
                                errorTimestamp: new Date().toISOString(),
                                processingTime: failureTime,
                                errorDetails: error instanceof Error ? {
                                    name: error.name,
                                    message: error.message,
                                    stack: error.stack
                                } : 'Unknown error type'
                            }
                        })
                        .eq('id', recordId);

                    if (result.error) throw result.error;
                    return result;
                });
            } catch (updateError) {
                elizaLogger.error('Failed to update record with error status:', updateError);
            }
        }

        return null;
    }
}

export async function getLatestGeneratedImage(): Promise<GeneratedImageRecord | null> {
    const startTime = Date.now();
    try {
        elizaLogger.log('Fetching latest generated image');

        const { data, error } = await retryOperation(async () => {
            const result = await supabase
                .from('generated_images')
                .select('*')
                .eq('status', 'completed')
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            if (result.error) throw result.error;
            return result;
        });

        const processingTime = Date.now() - startTime;
        if (data) {
            elizaLogger.log('Retrieved latest image:', {
                id: data.id,
                url: data.storage_path,
                processingTime: `${processingTime}ms`
            });
            return data as GeneratedImageRecord;
        } else {
            elizaLogger.warn('No completed images found in database');
            return null;
        }
    } catch (error) {
        const processingTime = Date.now() - startTime;
        elizaLogger.error('Error fetching latest image:', {
            error,
            processingTime: `${processingTime}ms`
        });
        return null;
    }
}

export async function getGeneratedImageById(id: string): Promise<GeneratedImageRecord | null> {
    const startTime = Date.now();
    try {
        elizaLogger.log('Fetching image by ID:', id);

        const { data, error } = await retryOperation(async () => {
            const result = await supabase
                .from('generated_images')
                .select('*')
                .eq('id', id)
                .single();

            if (result.error) throw result.error;
            return result;
        });

        const processingTime = Date.now() - startTime;
        if (data) {
            elizaLogger.log('Retrieved image by ID:', {
                id: data.id,
                url: data.storage_path,
                status: data.status,
                processingTime: `${processingTime}ms`
            });
            return data as GeneratedImageRecord;
        } else {
            elizaLogger.warn('No image found with ID:', id);
            return null;
        }
    } catch (error) {
        const processingTime = Date.now() - startTime;
        elizaLogger.error('Error fetching image by ID:', {
            error,
            id,
            processingTime: `${processingTime}ms`
        });
        return null;
    }
}

// Add a new function to check image availability
export async function verifyImageAccess(record: GeneratedImageRecord): Promise<boolean> {
    try {
        elizaLogger.log('Verifying image access:', record.storage_path);

        // Try to fetch the image headers to verify it exists and is accessible
        const response = await fetch(record.storage_path, { method: 'HEAD' });

        const isAccessible = response.ok &&
            response.headers.get('content-type')?.startsWith('image/');

        elizaLogger.log('Image access verification:', {
            url: record.storage_path,
            status: response.status,
            contentType: response.headers.get('content-type'),
            isAccessible
        });

        return isAccessible;
    } catch (error) {
        elizaLogger.error('Error verifying image access:', {
            error,
            url: record.storage_path
        });
        return false;
    }
}