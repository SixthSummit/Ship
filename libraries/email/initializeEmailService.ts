import Logger from "../app/utils/Logger.js";
import EmailService from "./EmailService.js";

/**
 * Singleton EmailService instance with registered templates
 * Available globally after initialization
 */
let emailServiceInstance: EmailService | null = null;

/**
 * Initialize the singleton EmailService instance and register all email templates
 * This function can be called from scripts or tests that need email functionality
 *
 * @returns The initialized EmailService instance
 * @throws Error if initialization fails
 */
export async function initializeEmailService(): Promise<EmailService> {
  // Return existing instance if already initialized
  if (emailServiceInstance) {
    return emailServiceInstance;
  }

  Logger.log("Initializing email templates...");

  try {
    // Create singleton EmailService instance
    // Uses RESEND_API_KEY and RESEND_DEFAULT_FROM environment variables
    emailServiceInstance = new EmailService();

    // Register templates from all modules
    //emailServiceInstance.registerTemplates(...);

    Logger.log(`Registered ${emailServiceInstance.listTemplates().length} email templates:`, {
      templateIds: emailServiceInstance.listTemplates().map((t) => t.id),
    });

    Logger.log("Email templates initialized successfully");

    return emailServiceInstance;
  } catch (error) {
    Logger.error("Error initializing email templates:", error);
    throw error;
  }
}

/**
 * Get the singleton EmailService instance
 *
 * @returns EmailService instance with all templates registered
 * @throws Error if called before initialization
 */
export function getEmailService(): EmailService {
  if (!emailServiceInstance) {
    throw new Error(
      "EmailService not initialized. Call initializeEmailService() first or ensure InitEmailTemplates bootstrapper has run.",
    );
  }

  return emailServiceInstance;
}
