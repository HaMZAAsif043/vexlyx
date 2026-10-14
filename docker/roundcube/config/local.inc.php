<?php
// TLS between Roundcube and Dovecot/Postfix (F4.1/F4.2).
//
// Secure by default: the certificate chain AND name are verified. Verification
// is only relaxed when ROUNDCUBE_MAIL_TLS_VERIFY is exactly "false", which only
// docker-compose.yml (local development) sets, because the dev stack's
// Dovecot/Postfix present a container-generated self-signed certificate that
// PHP's IMAP/SMTP client cannot interactively trust. Any other value, or the
// variable being absent, keeps verification on, so a missing/typo'd setting
// can never silently disable it in production.
//
// Roundcube connects to the Docker service names (tls://dovecot, tls://postfix),
// but the production certificate is issued for the public mail hostname, not
// for those names. ROUNDCUBE_MAIL_TLS_PEER_NAME makes PHP validate the
// certificate against that hostname instead of the service name.
$verify_mail_tls = getenv('ROUNDCUBE_MAIL_TLS_VERIFY') !== 'false';
$mail_tls_peer_name = getenv('ROUNDCUBE_MAIL_TLS_PEER_NAME');

$mail_tls_options = [
    'verify_peer' => $verify_mail_tls,
    'verify_peer_name' => $verify_mail_tls,
    'allow_self_signed' => !$verify_mail_tls,
];

if ($verify_mail_tls && is_string($mail_tls_peer_name) && $mail_tls_peer_name !== '') {
    $mail_tls_options['peer_name'] = $mail_tls_peer_name;
}

$config['imap_conn_options'] = ['ssl' => $mail_tls_options];
$config['smtp_conn_options'] = ['ssl' => $mail_tls_options];
