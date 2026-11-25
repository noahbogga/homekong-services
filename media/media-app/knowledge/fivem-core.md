# FiveM Server Knowledge Base — HOMEKONG

## Architecture
- Production: hk-fxmain VM (192.168.50.235, Ubuntu 22.04 Linux, 22c/32GB)
- Debug: hk-fxtest VM (192.168.50.236, Ubuntu 22.04, 4c/16GB)
- txAdmin panel: tx.homekong.cc (main), debug.homekong.online (test)
- MariaDB on hk-fxmain for game database

## GTA V RPM Model
- RPM is 0-1 float, non-linear
- Idle floor: exactly 0.200
- Gear 2+ ceiling: ~0.985
- Raw RPM from GetVehicleCurrentRpm() is ground truth
- RPM behavior is emergent from engine simulation, not a simple formula

## Handling Tuning
- Vehicle handling defined in handling.meta XML files
- Key fields: fMass, fDriveForce, fBrakeForce, fTractionCurveMax/Min, fSuspensionForce
- hk-handling script: custom handling override system
- Modes: Manual (mode 1) and Sequential (mode 6) are separate branches
- Sequential engages with bog (no neutral state)
- Config namespaces: Manual/Seq/DCT
- Preset ratios derived from real car data

## Scripting
- Server-side: Lua (primary), C# (occasional)
- Client-side: Lua with FiveM natives
- Resources in: /fxMain/resources/ and /fxTest/resources/
- txData config at: /opt/fxserver/server/txData/default/ (Linux; old Windows Z:HOMEKONG path retired)

## Key Natives
- GetVehicleCurrentRpm, SetVehicleCurrentRpm
- GetVehicleCurrentGear, SetVehicleCurrentGear
- SetVehicleHandlingFloat/Int for runtime handling overrides
- GetEntitySpeed, GetVehicleThrottleOffset
- CreateThread, Wait, RegisterNetEvent, TriggerServerEvent
- GetVehicleWheelSpeed, SetVehicleEngineTorqueMultiplier

## Game Physics
- GTA uses a simplified physics model, not real tire physics
- Traction curve: defined by min/max + lateral multiplier
- Suspension: spring/damp/raise affect visual + grip transfer
- Weight transfer is simulated but simplified
- Downforce: fDownforceModifier (only at speed)

## File Structure
- /fxMain/ — production server files
- /fxTest/ — debug/test server files  
- /Media/ — shared media assets
- Server configs: server.cfg in txData

## Network
- VPS relay at 103.231.59.28 (WireGuard tunnel)
- hk-fxtest peer: 10.66.66.3, VPS: 10.66.66.1
- Game port: default 30120
