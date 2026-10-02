param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference='Stop'
try {
    $item=Get-Item -LiteralPath $Path
    if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid output folder' }
    if($item.Name -notmatch '^[0-9a-fA-F-]{36}$' -or $item.Parent.Name -ne 'requests') { throw 'Invalid output folder' }
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true,$false)
    foreach($principal in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $rule=[Security.AccessControl.FileSystemAccessRule]::new($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $item.FullName -AclObject $acl
    $observed=Get-Acl -LiteralPath $item.FullName
    $allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544')
    $extra=@($observed.Access|Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed})
    if($extra.Count -ne 0 -or -not $observed.AreAccessRulesProtected){throw 'Private access not confirmed'}
    Write-Output '{"private":true}'
} catch {
    Write-Output '{"private":false}'
    exit 1
}
