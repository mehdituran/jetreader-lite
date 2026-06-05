<?php
/**
 * Fired during plugin deactivation.
 *
 * @package JetReader
 */

// If this file is called directly, abort.
if ( ! defined( 'WPINC' ) ) {
    die;
}

/**
 * Class JetReader_Deactivator
 *
 * Handles plugin deactivation tasks.
 */
class JetReader_Deactivator {

    /**
     * Deactivate the plugin.
     */
    public static function deactivate() {
        self::clear_scheduled_tasks();
    }

    /**
     * Clear any scheduled cron jobs.
     */
    private static function clear_scheduled_tasks() {
        wp_clear_scheduled_hook( 'jetreader_process_queue' );
        wp_clear_scheduled_hook( 'jetreader_cleanup_temp' );
        wp_clear_scheduled_hook( 'jetreader_index_item' );
        wp_clear_scheduled_hook( 'jetreader_rebuild_index' );
        wp_clear_scheduled_hook( 'jetreader_daily_license_check' );
    }
}