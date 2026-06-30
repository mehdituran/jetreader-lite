<?php
// If this file is called directly, abort.
if ( ! defined( 'WPINC' ) ) {
    die;
}

/**
 * The code that runs during plugin activation.
 */
function jetreader_activate() {
    require_once JETREADER_PLUGIN_DIR . 'includes/class-activator.php';
    JetReader_Activator::activate();
}

/**
 * The code that runs during plugin deactivation.
 */
function jetreader_deactivate() {
    require_once JETREADER_PLUGIN_DIR . 'includes/class-deactivator.php';
    JetReader_Deactivator::deactivate();
}

/**
 * Begins execution of the plugin.
 */
function jetreader_run() {
    $plugin = new JetReader();
    $plugin->run();
}
