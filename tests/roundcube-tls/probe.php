<?php
// Exercise the actual client classes shipped in the pinned Roundcube image.
define('INSTALL_PATH', '/usr/src/roundcubemail/');
require INSTALL_PATH . 'program/include/iniset.php';
$config = [];
require '/test/local.inc.php';
$roundcube = rcube::get_instance();
foreach ($config as $key => $value) {
    $roundcube->config->set($key, $value);
}
$roundcube->config->set('smtp_timeout', 5);
$roundcube->config->set('smtp_helo_host', 'roundcube-test.example');
$roundcube->config->set('smtp_auth_type', 'PLAIN');
$warnings = [];
$user = $argv[4] ?? 'tls-test@roundcube-test.example';
$password = $argv[5] ?? 'fixture-password';
set_error_handler(function ($severity, $message) use (&$warnings) {
    $warnings[] = $message;
    return true;
});
if ($argv[1] === 'imap') {
    $client = new rcube_imap_generic();
    $ok = $client->connect($argv[2], $user, $password, [
        'ssl_mode' => 'ssl',
        'port' => (int) $argv[3],
        'timeout' => 5,
        'auth_type' => 'IMAP',
        'socket_options' => $config['imap_conn_options'],
    ]);
    if ($ok) {
        $client->closeConnection();
    }
} elseif ($argv[1] === 'anonymous') {
    $client = new Net_SMTP('ssl://' . $argv[2], (int) $argv[3],
        'roundcube-test.example', false, 0, $config['smtp_conn_options']);
    $connected = $client->connect(5);
    if (is_a($connected, 'PEAR_Error')) {
        throw new RuntimeException('Anonymous probe could not establish verified TLS.');
    }
    $client->mailFrom($user);
    $ok = is_a($client->rcptTo($user), 'PEAR_Error');
    $client->disconnect();
} else {
    $client = new rcube_smtp();
    $ok = $client->connect('ssl://' . $argv[2], (int) $argv[3],
        $user, $password);
    if ($ok && $argv[1] === 'send') {
        $marker = $argv[6];
        $ok = $client->send_mail($user, [$user],
            "From: $user\r\nTo: $user\r\nSubject: $marker\r\n",
            'Local delivery under strict certificate verification.');
    }
    $client->disconnect();
}
restore_error_handler();
echo json_encode(['ok' => $ok, 'warnings' => $warnings]);
